import Foundation
import Observation
import Photos
import Vision

struct AssetGroup: Identifiable {
    let id: String
    /// Best item first.
    let assets: [PHAsset]

    init(assets: [PHAsset]) {
        self.assets = assets
        self.id = assets.map(\.localIdentifier).joined(separator: "|")
    }

    var best: PHAsset { assets[0] }
    var extras: [PHAsset] { Array(assets.dropFirst()) }
}

enum ScanPhase: Equatable {
    case idle
    case scanning(stage: String, progress: Double?)
    case finished
}

/// The app's single source of truth: the scan results for every clean-up category,
/// and the actions that change the photo library.
@MainActor
@Observable
final class PhotoLibrary {
    var authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    var phase: ScanPhase = .idle

    private(set) var photos: [PHAsset] = []
    private(set) var videos: [PHAsset] = []
    private(set) var duplicates: [AssetGroup] = []
    private(set) var similar: [AssetGroup] = []
    private(set) var screenshots: [PHAsset] = []
    private(set) var livePhotos: [PHAsset] = []
    private(set) var blurry: [PHAsset] = []
    private(set) var largeVideos: [PHAsset] = []

    /// Set while a long action runs (deleting, converting, compressing). Shown as a progress overlay.
    var busyMessage: String?
    var alertMessage: String?

    /// How alike two photos must look to be "similar". Lower is stricter.
    var similarThreshold: Double = UserDefaults.standard.object(forKey: "similarThreshold") as? Double ?? 0.45 {
        didSet { UserDefaults.standard.set(similarThreshold, forKey: "similarThreshold") }
    }
    /// Photos less sharp than this count as blurry.
    var blurThreshold: Double = UserDefaults.standard.object(forKey: "blurThreshold") as? Double ?? 40 {
        didSet { UserDefaults.standard.set(blurThreshold, forKey: "blurThreshold") }
    }

    @ObservationIgnored private var entries: [String: AnalysisEntry] = [:]
    @ObservationIgnored private var cacheLoaded = false
    @ObservationIgnored private var decodedPrints: [String: VNFeaturePrintObservation] = [:]

    var isScanning: Bool {
        if case .scanning = phase { return true }
        return false
    }

    // MARK: Sizes

    func bytes(of asset: PHAsset) -> Int64 { entries[asset.localIdentifier]?.bytes ?? 0 }
    func bytes(of assets: [PHAsset]) -> Int64 { assets.reduce(0) { $0 + bytes(of: $1) } }
    func liveVideoBytes(of asset: PHAsset) -> Int64 { entries[asset.localIdentifier]?.liveVideoBytes ?? 0 }
    func sharpness(of asset: PHAsset) -> Float? { entries[asset.localIdentifier]?.sharpness }

    var libraryBytes: Int64 { bytes(of: photos) + bytes(of: videos) }
    var duplicateBytes: Int64 { duplicates.reduce(0) { $0 + bytes(of: $1.extras) } }
    var similarBytes: Int64 { similar.reduce(0) { $0 + bytes(of: $1.extras) } }
    var liveVideoBytesTotal: Int64 { livePhotos.reduce(0) { $0 + liveVideoBytes(of: $1) } }

    // MARK: Access

    func requestAccess() async {
        authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }

    // MARK: Scanning

    func scan() async {
        guard !isScanning else { return }
        phase = .scanning(stage: "Reading your library…", progress: nil)

        if !cacheLoaded {
            entries = await Task.detached(priority: .userInitiated) { AnalysisCache.load() }.value
            cacheLoaded = true
        }
        let (allPhotos, allVideos) = Self.fetchAll()
        photos = allPhotos
        videos = allVideos

        // Pass 1: size, hash and sharpness for everything new or changed; feature prints for photos
        // taken close together (the only ones that can be "similar").
        let printCandidates = Grouper.similarCandidates(allPhotos.filter { !$0.isScreenshot })
        let work = (allPhotos + allVideos).compactMap { asset -> AnalysisItem? in
            let needsPrint = printCandidates.contains(asset.localIdentifier)
            if let e = entries[asset.localIdentifier], e.isCurrent(for: asset, needsPrint: needsPrint) { return nil }
            return AnalysisItem(asset: asset, needsPrint: needsPrint)
        }
        await analyze(work, stage: "Analysing photos & videos")

        // Pass 2: feature prints for possible duplicates that don't have one yet, to confirm them.
        let candidates = Grouper.duplicateCandidates(allPhotos, entries: entries)
            + Grouper.duplicateCandidates(allVideos, entries: entries)
        let needPrints = candidates.joined().filter { entries[$0.localIdentifier]?.printTried != true }
        await analyze(needPrints.map { AnalysisItem(asset: $0, needsPrint: true) }, stage: "Checking duplicates")

        // Forget anything no longer in the library, then save.
        let present = Set((allPhotos + allVideos).map(\.localIdentifier))
        entries = entries.filter { present.contains($0.key) }
        let snapshot = entries
        Task.detached(priority: .utility) { AnalysisCache.save(snapshot) }

        regroup()
        phase = .finished
    }

    /// Runs the analyzer over the items, a few at a time, updating progress as it goes.
    private func analyze(_ items: [AnalysisItem], stage: String) async {
        guard !items.isEmpty else { return }
        let analyzer = Analyzer()
        let total = items.count
        var done = 0
        var next = 0
        phase = .scanning(stage: stage, progress: 0)

        await withTaskGroup(of: (String, AnalysisEntry).self) { group in
            func enqueue() {
                let item = items[next]
                let previous = entries[item.asset.localIdentifier]
                group.addTask { (item.asset.localIdentifier, analyzer.analyze(item, previous: previous)) }
                next += 1
            }
            while next < min(6, total) { enqueue() }
            while let result = await group.next() {
                let (id, entry) = result
                entries[id] = entry
                decodedPrints[id] = nil
                done += 1
                if done % 20 == 0 || done == total {
                    phase = .scanning(stage: stage, progress: Double(done) / Double(total))
                }
                if next < total { enqueue() }
            }
        }
    }

    private static func fetchAll() -> ([PHAsset], [PHAsset]) {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        var photos: [PHAsset] = []
        var videos: [PHAsset] = []
        PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in photos.append(asset) }
        PHAsset.fetchAssets(with: .video, options: options).enumerateObjects { asset, _, _ in videos.append(asset) }
        return (photos, videos)
    }

    private func featurePrint(_ id: String) -> VNFeaturePrintObservation? {
        if let cached = decodedPrints[id] { return cached }
        guard let data = entries[id]?.featurePrint, let print = FeaturePrints.decode(data) else { return nil }
        decodedPrints[id] = print
        return print
    }

    /// Rebuilds every category from the stored analysis. Quick, so it also runs when a setting changes.
    func regroup() {
        let lookup: Grouper.PrintLookup = { [unowned self] in self.featurePrint($0) }

        let candidates = Grouper.duplicateCandidates(photos, entries: entries)
            + Grouper.duplicateCandidates(videos, entries: entries)
        duplicates = candidates
            .flatMap { Grouper.confirmDuplicates($0, entries: entries, prints: lookup) }
            .map { AssetGroup(assets: Grouper.rankDuplicates($0, entries: entries)) }
            .sorted { bytes(of: $0.extras) > bytes(of: $1.extras) }

        // Extra copies already show under Duplicates, so leave them out of Similar.
        let duplicateExtras = Set(duplicates.flatMap { $0.extras.map(\.localIdentifier) })
        let similarPool = photos.filter { !$0.isScreenshot && !duplicateExtras.contains($0.localIdentifier) }
        similar = Grouper.similarGroups(similarPool, prints: lookup, threshold: Float(similarThreshold))
            .map { AssetGroup(assets: Grouper.rankSimilar($0, entries: entries)) }
            .sorted { ($0.best.creationDate ?? .distantPast) > ($1.best.creationDate ?? .distantPast) }

        screenshots = photos.filter(\.isScreenshot).reversed()

        livePhotos = photos
            .filter { $0.mediaSubtypes.contains(.photoLive) }
            .sorted { liveVideoBytes(of: $0) > liveVideoBytes(of: $1) }

        blurry = photos
            .filter { asset in
                guard !asset.isScreenshot, let e = entries[asset.localIdentifier], e.hashBits != 0 else { return false }
                return Double(e.sharpness) < blurThreshold || e.contrast < Grouper.minimumContrast
            }
            .sorted { (sharpness(of: $0) ?? 0) < (sharpness(of: $1) ?? 0) }

        largeVideos = videos.sorted { bytes(of: $0) > bytes(of: $1) }
    }

    func clearCache() async {
        guard !isScanning else { return }
        entries = [:]
        decodedPrints = [:]
        await Task.detached { AnalysisCache.clear() }.value
        phase = .idle
        await scan()
    }

    // MARK: Actions

    /// Deletes through iOS's confirmation. Items go to Recently Deleted. Returns true if deleted.
    @discardableResult
    func delete(_ assets: [PHAsset]) async -> Bool {
        guard !assets.isEmpty else { return false }
        let ids = assets.map(\.localIdentifier)
        busyMessage = "Deleting…"
        defer { busyMessage = nil }
        do {
            try await MediaTools.delete(ids)
            forget(Set(ids))
            return true
        } catch {
            if !MediaTools.isCancellation(error) { alertMessage = error.localizedDescription }
            return false
        }
    }

    /// Replaces each Live Photo with a plain photo, then removes the originals in one confirmation.
    func convertLivePhotos(_ assets: [PHAsset]) async {
        guard !assets.isEmpty else { return }
        var converted: [PHAsset] = []
        var failures: [String] = []
        for (index, asset) in assets.enumerated() {
            busyMessage = "Converting \(index + 1) of \(assets.count)…"
            do {
                try await MediaTools.saveStillCopy(of: asset)
                converted.append(asset)
            } catch {
                failures.append(error.localizedDescription)
            }
        }
        busyMessage = nil

        if !converted.isEmpty {
            let removed = await delete(converted)
            if !removed {
                alertMessage = "The still photos were saved, but the Live Photos weren't deleted, so you now have both. "
                    + "They'll show up under Duplicates after the next scan."
            }
        }
        if !failures.isEmpty {
            alertMessage = "\(failures.count) couldn't be converted. \(failures.first ?? "")"
        }
        await scan()
    }

    /// Saves smaller copies of the videos, then removes the originals in one confirmation.
    func compressVideos(_ assets: [PHAsset], quality: VideoQuality) async {
        guard !assets.isEmpty else { return }
        var replaced: [PHAsset] = []
        var saved: Int64 = 0
        var skipped = 0
        var failures: [String] = []
        for (index, asset) in assets.enumerated() {
            busyMessage = "Compressing \(index + 1) of \(assets.count)…\nKeep the app open."
            do {
                saved += try await MediaTools.saveCompressedCopy(of: asset, quality: quality, originalBytes: bytes(of: asset))
                replaced.append(asset)
            } catch MediaToolError.notSmaller {
                skipped += 1
            } catch {
                failures.append(error.localizedDescription)
            }
        }
        busyMessage = nil

        var notes: [String] = []
        if !replaced.isEmpty {
            if await delete(replaced) {
                notes.append("Saved \(saved.formattedBytes).")
            } else {
                notes.append("The smaller copies were saved, but the originals weren't deleted.")
            }
        }
        if skipped > 0 { notes.append("\(skipped) already small enough, left as they were.") }
        if !failures.isEmpty { notes.append("\(failures.count) failed: \(failures.first ?? "")") }
        alertMessage = notes.joined(separator: " ")
        await scan()
    }

    private func forget(_ ids: Set<String>) {
        photos.removeAll { ids.contains($0.localIdentifier) }
        videos.removeAll { ids.contains($0.localIdentifier) }
        for id in ids {
            entries[id] = nil
            decodedPrints[id] = nil
        }
        regroup()
    }
}

extension PHAsset {
    var isScreenshot: Bool { mediaSubtypes.contains(.photoScreenshot) }
    var isLivePhoto: Bool { mediaSubtypes.contains(.photoLive) }
}

extension Int64 {
    var formattedBytes: String { ByteCountFormatter.string(fromByteCount: self, countStyle: .file) }
}
