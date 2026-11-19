import AVFoundation
import Foundation
import Photos
import UniformTypeIdentifiers

enum MediaToolError: LocalizedError {
    case missingPhoto
    case videoUnavailable
    case exportFailed
    case notSmaller

    var errorDescription: String? {
        switch self {
        case .missingPhoto: "The photo part of this Live Photo couldn't be found."
        case .videoUnavailable: "The video couldn't be loaded. If it's in iCloud, check your connection."
        case .exportFailed: "The video couldn't be compressed."
        case .notSmaller: "Compressing wouldn't make this video meaningfully smaller."
        }
    }
}

enum VideoQuality: String, CaseIterable, Identifiable {
    case hevc1080 = "1080p HEVC"
    case hevc4k = "4K HEVC"
    case h264720 = "720p"

    var id: String { rawValue }

    var preset: String {
        switch self {
        case .hevc1080: AVAssetExportPresetHEVC1920x1080
        case .hevc4k: AVAssetExportPresetHEVC3840x2160
        case .h264720: AVAssetExportPreset1280x720
        }
    }

    var detail: String {
        switch self {
        case .hevc1080: "Full HD, efficient. Good for most videos."
        case .hevc4k: "Keeps 4K, smaller file. Least saving."
        case .h264720: "Smallest files. Fine for phone viewing."
        }
    }
}

/// Changes to the photo library. Every delete goes through iOS's own confirmation and lands in
/// Recently Deleted, so anything removed can be recovered for 30 days.
enum MediaTools {
    static func delete(_ localIdentifiers: [String]) async throws {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: localIdentifiers, options: nil)
        guard assets.count > 0 else { return }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetChangeRequest.deleteAssets(assets as NSFastEnumeration)
        }
    }

    static func isCancellation(_ error: Error) -> Bool {
        if let photosError = error as? PHPhotosError, photosError.code == .userCancelled { return true }
        let ns = error as NSError
        return ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError
    }

    // MARK: Live Photo → still photo

    /// Saves a plain photo copy of a Live Photo (same date, place, favourite and albums).
    /// The caller deletes the original afterwards, in one batch.
    static func saveStillCopy(of asset: PHAsset) async throws {
        let resources = PHAssetResource.assetResources(for: asset)
        // fullSizePhoto is the edited version, if the photo was edited. Otherwise use the original.
        guard let photo = resources.first(where: { $0.type == .fullSizePhoto })
                ?? resources.first(where: { $0.type == .photo }) else {
            throw MediaToolError.missingPhoto
        }
        let ext = UTType(photo.uniformTypeIdentifier)?.preferredFilenameExtension ?? "heic"
        let url = temporaryURL(ext)
        try await write(photo, to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let albums = userAlbums(containing: asset)
        try await PHPhotoLibrary.shared().performChanges {
            let request = PHAssetCreationRequest.forAsset()
            request.addResource(with: .photo, fileURL: url, options: nil)
            copyDetails(from: asset, to: request, albums: albums)
        }
    }

    // MARK: Video compression

    /// Saves a re-encoded, smaller copy of a video. Returns the bytes saved.
    /// The caller deletes the original afterwards.
    static func saveCompressedCopy(of asset: PHAsset, quality: VideoQuality, originalBytes: Int64) async throws -> Int64 {
        let avAsset = try await loadAVAsset(asset)
        guard let session = AVAssetExportSession(asset: avAsset, presetName: quality.preset) else {
            throw MediaToolError.exportFailed
        }
        let url = temporaryURL("mov")
        session.outputURL = url
        session.outputFileType = .mov
        session.shouldOptimizeForNetworkUse = true
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
        }
        defer { try? FileManager.default.removeItem(at: url) }
        guard session.status == .completed else { throw session.error ?? MediaToolError.exportFailed }

        let newBytes = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
        // Not worth replacing the original for less than a 10% saving.
        guard newBytes > 0, originalBytes == 0 || Double(newBytes) < Double(originalBytes) * 0.9 else {
            throw MediaToolError.notSmaller
        }

        let albums = userAlbums(containing: asset)
        try await PHPhotoLibrary.shared().performChanges {
            let request = PHAssetCreationRequest.forAsset()
            request.addResource(with: .video, fileURL: url, options: nil)
            copyDetails(from: asset, to: request, albums: albums)
        }
        return max(0, originalBytes - newBytes)
    }

    // MARK: Helpers

    private static func copyDetails(from asset: PHAsset, to request: PHAssetCreationRequest, albums: [PHAssetCollection]) {
        request.creationDate = asset.creationDate
        request.location = asset.location
        request.isFavorite = asset.isFavorite
        request.isHidden = asset.isHidden
        guard let placeholder = request.placeholderForCreatedAsset else { return }
        for album in albums {
            PHAssetCollectionChangeRequest(for: album)?.addAssets([placeholder] as NSArray)
        }
    }

    private static func userAlbums(containing asset: PHAsset) -> [PHAssetCollection] {
        var albums: [PHAssetCollection] = []
        PHAssetCollection.fetchAssetCollectionsContaining(asset, with: .album, options: nil).enumerateObjects { album, _, _ in
            if album.assetCollectionSubtype == .albumRegular, album.canPerform(.addContent) {
                albums.append(album)
            }
        }
        return albums
    }

    private static func temporaryURL(_ ext: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext)
    }

    private static func write(_ resource: PHAssetResource, to url: URL) async throws {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    private static func loadAVAsset(_ asset: PHAsset) async throws -> AVAsset {
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current
        return try await withCheckedThrowingContinuation { continuation in
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, info in
                if let avAsset {
                    continuation.resume(returning: avAsset)
                } else {
                    continuation.resume(throwing: (info?[PHImageErrorKey] as? Error) ?? MediaToolError.videoUnavailable)
                }
            }
        }
    }
}
