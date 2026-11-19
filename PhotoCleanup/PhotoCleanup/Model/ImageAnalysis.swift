import CoreGraphics
import Foundation
import Photos
import UIKit
import Vision

/// What the scanner remembers about one photo or video. Saved to disk so later scans are quick.
struct AnalysisEntry: Codable {
    /// The asset's modification date when it was analysed. A different date means analyse again.
    var modified: Date?
    /// Bytes used by the asset's files (original, edits, Live Photo video).
    var bytes: Int64
    /// Bytes used by the hidden video half of a Live Photo, 0 otherwise.
    var liveVideoBytes: Int64
    /// 64-bit difference hash of a small thumbnail, stored as a bit pattern.
    var hashBits: Int64
    /// Variance of the Laplacian. Low means blurry.
    var sharpness: Float
    /// Standard deviation of brightness. Very low means a black, white or blank shot.
    var contrast: Float
    /// Archived Vision feature print, used to compare how alike two pictures look.
    var featurePrint: Data?
    /// True once a feature print has been attempted, so failures aren't retried every scan.
    var printTried: Bool

    var hash: UInt64 { UInt64(bitPattern: hashBits) }

    func isCurrent(for asset: PHAsset, needsPrint: Bool) -> Bool {
        guard modified == asset.modificationDate else { return false }
        return !needsPrint || printTried
    }
}

struct AnalysisItem {
    let asset: PHAsset
    let needsPrint: Bool
}

/// Works on background threads: loads a small thumbnail and measures it.
final class Analyzer {
    func analyze(_ item: AnalysisItem, previous: AnalysisEntry?) -> AnalysisEntry {
        autoreleasepool { () -> AnalysisEntry in
            let asset = item.asset
            let (bytes, liveBytes) = Self.fileSizes(of: asset)

            // Reuse the picture measurements if only the feature print is missing.
            if var previous, previous.modified == asset.modificationDate, item.needsPrint, !previous.printTried {
                previous.bytes = bytes
                previous.liveVideoBytes = liveBytes
                if let image = Self.thumbnail(for: asset, side: 256) {
                    previous.featurePrint = FeaturePrints.make(image)
                }
                previous.printTried = true
                return previous
            }

            var entry = AnalysisEntry(modified: asset.modificationDate, bytes: bytes, liveVideoBytes: liveBytes,
                                      hashBits: 0, sharpness: .greatestFiniteMagnitude, contrast: 255,
                                      featurePrint: nil, printTried: false)
            guard let image = Self.thumbnail(for: asset, side: 256) else { return entry }
            entry.hashBits = Int64(bitPattern: ImageMath.differenceHash(image))
            let (sharpness, contrast) = ImageMath.sharpnessAndContrast(image)
            entry.sharpness = sharpness
            entry.contrast = contrast
            if item.needsPrint {
                entry.featurePrint = FeaturePrints.make(image)
                entry.printTried = true
            }
            return entry
        }
    }

    static func fileSizes(of asset: PHAsset) -> (total: Int64, liveVideo: Int64) {
        var total: Int64 = 0
        var live: Int64 = 0
        for resource in PHAssetResource.assetResources(for: asset) {
            // "fileSize" is not public API, but it is the only way to read sizes without downloading.
            let size = (resource.value(forKey: "fileSize") as? NSNumber)?.int64Value ?? 0
            total += size
            if resource.type == .pairedVideo || resource.type == .fullSizePairedVideo { live += size }
        }
        return (total, live)
    }

    /// Synchronous thumbnail request. Call from a background thread only.
    static func thumbnail(for asset: PHAsset, side: CGFloat) -> CGImage? {
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        options.deliveryMode = .highQualityFormat
        var result: CGImage?
        let size = CGSize(width: side, height: side)
        PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: options) { image, _ in
            result = image?.cgImage
        }
        if result == nil {
            // iCloud-only items may not have a high quality thumbnail on the phone. Take what's there.
            options.deliveryMode = .fastFormat
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: options) { image, _ in
                result = image?.cgImage
            }
        }
        return result
    }
}

enum ImageMath {
    /// Draws the image into an 8-bit grayscale buffer of the given size.
    static func grayscale(_ image: CGImage, width: Int, height: Int) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: width * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: width,
                                          space: CGColorSpaceCreateDeviceGray(),
                                          bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return pixels
    }

    /// dHash: shrink to 9x8 and record whether each pixel is brighter than its right neighbour.
    /// Copies of the same picture (resized, re-saved, re-compressed) end up with nearly the same 64 bits.
    static func differenceHash(_ image: CGImage) -> UInt64 {
        let p = grayscale(image, width: 9, height: 8)
        var hash: UInt64 = 0
        for y in 0..<8 {
            for x in 0..<8 {
                hash <<= 1
                if p[y * 9 + x] > p[y * 9 + x + 1] { hash |= 1 }
            }
        }
        return hash
    }

    /// Sharpness is the variance of the Laplacian (edge strength); contrast is the brightness standard deviation.
    static func sharpnessAndContrast(_ image: CGImage) -> (Float, Float) {
        let scale = min(1.0, 256.0 / Double(max(image.width, image.height, 1)))
        let w = max(3, Int(Double(image.width) * scale))
        let h = max(3, Int(Double(image.height) * scale))
        let pixels = grayscale(image, width: w, height: h)
        return pixels.withUnsafeBufferPointer { p -> (Float, Float) in
            var sum = 0.0, sumSq = 0.0
            for v in p { let d = Double(v); sum += d; sumSq += d * d }
            let n = Double(p.count)
            let mean = sum / n
            let contrast = (max(0, sumSq / n - mean * mean)).squareRoot()

            var lSum = 0.0, lSq = 0.0, count = 0.0
            for y in 1..<(h - 1) {
                for x in 1..<(w - 1) {
                    let i = y * w + x
                    let l = 4 * Double(p[i]) - Double(p[i - 1]) - Double(p[i + 1]) - Double(p[i - w]) - Double(p[i + w])
                    lSum += l; lSq += l * l; count += 1
                }
            }
            let lMean = lSum / count
            return (Float(lSq / count - lMean * lMean), Float(contrast))
        }
    }
}

enum FeaturePrints {
    static func make(_ image: CGImage) -> Data? {
        let request = VNGenerateImageFeaturePrintRequest()
        request.imageCropAndScaleOption = .scaleFill
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
            guard let observation = request.results?.first else { return nil }
            return try NSKeyedArchiver.archivedData(withRootObject: observation, requiringSecureCoding: true)
        } catch {
            return nil
        }
    }

    static func decode(_ data: Data) -> VNFeaturePrintObservation? {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: VNFeaturePrintObservation.self, from: data)
    }

    static func distance(_ a: VNFeaturePrintObservation, _ b: VNFeaturePrintObservation) -> Float? {
        var d: Float = 0
        do {
            try a.computeDistance(&d, to: b)
            return d
        } catch {
            return nil
        }
    }
}

/// Keeps analysis results between launches in Application Support.
enum AnalysisCache {
    private static var url: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("analysis-v1.plist")
    }

    static func load() -> [String: AnalysisEntry] {
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? PropertyListDecoder().decode([String: AnalysisEntry].self, from: data)) ?? [:]
    }

    static func save(_ entries: [String: AnalysisEntry]) {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        guard let data = try? encoder.encode(entries) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}
