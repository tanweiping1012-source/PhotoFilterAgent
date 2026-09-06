import CoreGraphics
import Foundation
import ImageIO

enum AIReviewPreviewEncodingError: LocalizedError {
    case cannotReadImage
    case cannotEncodePreview

    var errorDescription: String? {
        switch self {
        case .cannotReadImage:
            String(localized: "无法读取其中一张候选照片，未发送任何照片。")
        case .cannotEncodePreview:
            String(localized: "无法生成 AI评分图片，未发送任何照片。")
        }
    }
}

/// 仅在内存内把本地原图重编码为无元数据 JPEG；绝不写入文件或上传原始文件。
enum AIReviewPreviewEncoder {
    static func thumbnailImage(
        for data: Data,
        maximumPixelSize: Int = AIReviewPreviewSize.small.maximumPixelSize
    ) throws -> CGImage {
        guard maximumPixelSize > 0,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            throw AIReviewPreviewEncodingError.cannotReadImage
        }

        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
            throw AIReviewPreviewEncodingError.cannotReadImage
        }
        return image
    }

    static func thumbnailImage(
        for url: URL,
        maximumPixelSize: Int = AIReviewPreviewSize.small.maximumPixelSize
    ) throws -> CGImage {
        guard let data = try? Data(contentsOf: url) else {
            throw AIReviewPreviewEncodingError.cannotReadImage
        }
        return try thumbnailImage(for: data, maximumPixelSize: maximumPixelSize)
    }

    static func jpegData(
        for image: CGImage,
        compressionQuality: Double = 0.82
    ) throws -> Data {
        guard compressionQuality > 0, compressionQuality <= 1 else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            "public.jpeg" as CFString,
            1,
            nil
        ) else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }

        // 只把像素写入新 JPEG，不复制 EXIF、GPS、文件名或源文件属性。
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: compressionQuality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        return try strippingPrivateMetadataSegments(output as Data)
    }

    static func jpegData(
        for data: Data,
        maximumPixelSize: Int = AIReviewPreviewSize.small.maximumPixelSize
    ) throws -> Data {
        try jpegData(for: thumbnailImage(for: data, maximumPixelSize: maximumPixelSize))
    }

    static func jpegData(
        for url: URL,
        maximumPixelSize: Int = AIReviewPreviewSize.small.maximumPixelSize
    ) throws -> Data {
        guard let data = try? Data(contentsOf: url) else {
            throw AIReviewPreviewEncodingError.cannotReadImage
        }
        return try jpegData(for: data, maximumPixelSize: maximumPixelSize)
    }

    /// ImageIO may synthesize APP1/APP13 containers even when no source metadata
    /// is copied. Remove privacy-bearing application/comment segments from the
    /// encoded JPEG while preserving JFIF (APP0), ICC (APP2), image tables and
    /// the entropy-coded scan verbatim.
    static func strippingPrivateMetadataSegments(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 4, bytes[0] == 0xff, bytes[1] == 0xd8 else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }

        var sanitized = Data(bytes[0...1])
        var cursor = 2
        var isInsideEntropyCodedScan = false
        while cursor < bytes.count {
            if isInsideEntropyCodedScan {
                let payloadStart = cursor
                var foundNextSegment = false
                while cursor < bytes.count {
                    guard bytes[cursor] == 0xff else {
                        cursor += 1
                        continue
                    }
                    let markerStart = cursor
                    while cursor < bytes.count, bytes[cursor] == 0xff {
                        cursor += 1
                    }
                    guard cursor < bytes.count else {
                        throw AIReviewPreviewEncodingError.cannotEncodePreview
                    }
                    let marker = bytes[cursor]
                    if marker == 0x00 || (0xd0...0xd7).contains(marker) {
                        // Escaped 0xff or a restart marker is part of scan data.
                        cursor += 1
                        continue
                    }
                    sanitized.append(contentsOf: bytes[payloadStart..<markerStart])
                    cursor = markerStart
                    isInsideEntropyCodedScan = false
                    foundNextSegment = true
                    break
                }
                guard foundNextSegment else {
                    throw AIReviewPreviewEncodingError.cannotEncodePreview
                }
                continue
            }

            let markerStart = cursor
            guard bytes[cursor] == 0xff else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            while cursor < bytes.count, bytes[cursor] == 0xff {
                cursor += 1
            }
            guard cursor < bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let marker = bytes[cursor]

            if marker == 0xd9 {
                sanitized.append(contentsOf: bytes[markerStart...cursor])
                guard cursor + 1 == bytes.count else {
                    throw AIReviewPreviewEncodingError.cannotEncodePreview
                }
                return sanitized
            }

            // Standalone markers do not carry a two-byte segment length.
            if marker == 0x01 || (0xd0...0xd7).contains(marker) {
                sanitized.append(contentsOf: bytes[markerStart...cursor])
                cursor += 1
                continue
            }

            guard marker != 0x00, cursor + 2 < bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let segmentLength = Int(bytes[cursor + 1]) << 8 | Int(bytes[cursor + 2])
            guard segmentLength >= 2 else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let segmentEnd = cursor + 1 + segmentLength
            guard segmentEnd <= bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }

            let shouldStrip = marker == 0xe1 || marker == 0xed || marker == 0xfe
            if !shouldStrip {
                sanitized.append(contentsOf: bytes[markerStart..<segmentEnd])
            }
            cursor = segmentEnd
            if marker == 0xda {
                isInsideEntropyCodedScan = true
            }
        }
        throw AIReviewPreviewEncodingError.cannotEncodePreview
    }
}
