import Foundation
import Photos
import Vision

struct UnionFind {
    private var parent: [Int]

    init(_ count: Int) { parent = Array(0..<count) }

    mutating func find(_ x: Int) -> Int {
        var x = x
        while parent[x] != x {
            parent[x] = parent[parent[x]]
            x = parent[x]
        }
        return x
    }

    mutating func union(_ a: Int, _ b: Int) {
        let ra = find(a), rb = find(b)
        if ra != rb { parent[rb] = ra }
    }

    mutating func groups(minSize: Int = 2) -> [[Int]] {
        var byRoot: [Int: [Int]] = [:]
        for i in parent.indices { byRoot[find(i), default: []].append(i) }
        return byRoot.values.filter { $0.count >= minSize }.map { $0.sorted() }
    }
}

/// Main-actor only: called from PhotoLibrary after analysis is done.
@MainActor
enum Grouper {
    /// Feature-print distance at or below which two candidates count as the same picture.
    static let duplicateDistance: Float = 0.25
    /// Photos further apart in time than this are never "similar".
    static let similarWindow: TimeInterval = 180
    /// Blank or black frames all hash alike, so they are left out of duplicate matching.
    static let minimumContrast: Float = 6

    typealias PrintLookup = @MainActor (String) -> VNFeaturePrintObservation?

    // MARK: Duplicates

    /// Fast first pass: assets whose thumbnails hash within 3 bits of each other and have the same shape.
    /// Any two hashes within 3 bits must share at least one of their four 16-bit chunks, so bucketing
    /// by chunk finds every close pair without comparing everything with everything.
    static func duplicateCandidates(_ assets: [PHAsset], entries: [String: AnalysisEntry]) -> [[PHAsset]] {
        let items: [(asset: PHAsset, hash: UInt64)] = assets.compactMap { asset in
            guard let e = entries[asset.localIdentifier], e.contrast >= minimumContrast, e.hashBits != 0 else { return nil }
            return (asset, e.hash)
        }
        var uf = UnionFind(items.count)
        var buckets: [Int: [Int]] = [:]
        for (i, item) in items.enumerated() {
            for chunk in 0..<4 {
                let value = Int((item.hash >> UInt64(chunk * 16)) & 0xFFFF)
                buckets[chunk << 16 | value, default: []].append(i)
            }
        }
        for members in buckets.values where members.count > 1 && members.count < 500 {
            for x in 0..<members.count {
                for y in (x + 1)..<members.count {
                    let i = members[x], j = members[y]
                    if (items[i].hash ^ items[j].hash).nonzeroBitCount <= 3,
                       compatible(items[i].asset, items[j].asset) {
                        uf.union(i, j)
                    }
                }
            }
        }
        return uf.groups().map { $0.map { items[$0].asset } }
    }

    /// Second pass: inside a candidate group, keep only pairs whose Vision feature prints agree.
    static func confirmDuplicates(_ group: [PHAsset], entries: [String: AnalysisEntry], prints: PrintLookup) -> [[PHAsset]] {
        var uf = UnionFind(group.count)
        for i in 0..<group.count {
            for j in (i + 1)..<group.count {
                let a = group[i].localIdentifier, b = group[j].localIdentifier
                if let pa = prints(a), let pb = prints(b), let d = FeaturePrints.distance(pa, pb) {
                    if d <= duplicateDistance { uf.union(i, j) }
                } else if let ea = entries[a], let eb = entries[b], (ea.hash ^ eb.hash).nonzeroBitCount <= 1 {
                    uf.union(i, j)
                }
            }
        }
        return uf.groups().map { $0.map { group[$0] } }
    }

    private static func compatible(_ a: PHAsset, _ b: PHAsset) -> Bool {
        guard a.mediaType == b.mediaType, a.pixelHeight > 0, b.pixelHeight > 0 else { return false }
        let ra = Double(a.pixelWidth) / Double(a.pixelHeight)
        let rb = Double(b.pixelWidth) / Double(b.pixelHeight)
        guard abs(ra - rb) / max(ra, rb) < 0.03 else { return false }
        if a.mediaType == .video { return abs(a.duration - b.duration) < 1.0 }
        return true
    }

    /// Best copy first: favourite, then highest resolution, then biggest file, then oldest.
    static func rankDuplicates(_ group: [PHAsset], entries: [String: AnalysisEntry]) -> [PHAsset] {
        group.sorted { a, b in
            if a.isFavorite != b.isFavorite { return a.isFavorite }
            let pa = a.pixelWidth * a.pixelHeight, pb = b.pixelWidth * b.pixelHeight
            if pa != pb { return pa > pb }
            let sa = entries[a.localIdentifier]?.bytes ?? 0, sb = entries[b.localIdentifier]?.bytes ?? 0
            if sa != sb { return sa > sb }
            return (a.creationDate ?? .distantFuture) < (b.creationDate ?? .distantFuture)
        }
    }

    // MARK: Similar

    /// Photos that sit next to another photo in time. Only these need the slower feature print.
    static func similarCandidates(_ photosByDate: [PHAsset]) -> Set<String> {
        var result = Set<String>()
        for i in 1..<max(photosByDate.count, 1) {
            let a = photosByDate[i - 1], b = photosByDate[i]
            guard let ta = a.creationDate, let tb = b.creationDate, tb.timeIntervalSince(ta) <= similarWindow else { continue }
            result.insert(a.localIdentifier)
            result.insert(b.localIdentifier)
        }
        return result
    }

    /// Bursts and near-identical shots taken within a few minutes of each other.
    static func similarGroups(_ photosByDate: [PHAsset], prints: PrintLookup, threshold: Float) -> [[PHAsset]] {
        var uf = UnionFind(photosByDate.count)
        for i in photosByDate.indices {
            guard let ti = photosByDate[i].creationDate, let pi = prints(photosByDate[i].localIdentifier) else { continue }
            for back in 1...3 where i - back >= 0 {
                let j = i - back
                guard let tj = photosByDate[j].creationDate, ti.timeIntervalSince(tj) <= similarWindow,
                      let pj = prints(photosByDate[j].localIdentifier),
                      let d = FeaturePrints.distance(pi, pj), d <= threshold else { continue }
                uf.union(i, j)
            }
        }
        return uf.groups().map { $0.map { photosByDate[$0] } }
    }

    /// Best shot first: favourite, then sharpest, then highest resolution.
    static func rankSimilar(_ group: [PHAsset], entries: [String: AnalysisEntry]) -> [PHAsset] {
        group.sorted { a, b in
            if a.isFavorite != b.isFavorite { return a.isFavorite }
            let sa = entries[a.localIdentifier]?.sharpness ?? 0, sb = entries[b.localIdentifier]?.sharpness ?? 0
            if sa != sb { return sa > sb }
            return a.pixelWidth * a.pixelHeight > b.pixelWidth * b.pixelHeight
        }
    }
}
