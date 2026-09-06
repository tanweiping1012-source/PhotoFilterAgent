import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import photofilter

final class AIReviewPreviewEncoderTests: XCTestCase {
    func testJPEGOutputRemovesPrivacySegmentsAndRemainsDecodable() throws {
        let encoded = try AIReviewPreviewEncoder.jpegData(for: try solidImage())

        let markers = try headerMarkers(in: encoded)
        XCTAssertFalse(markers.contains(0xe1), "APP1 must not leave the process")
        XCTAssertFalse(markers.contains(0xed), "APP13 must not leave the process")
        XCTAssertFalse(markers.contains(0xfe), "COM must not leave the process")
        XCTAssertNotNil(CGImageSourceCreateWithData(encoded as CFData, nil))
    }

    func testSanitizerStripsInjectedMetadataButPreservesICC() throws {
        let base = try AIReviewPreviewEncoder.jpegData(for: try solidImage())
        var injected = Data([0xff, 0xd8])
        injected.append(segment(marker: 0xe1, payload: Data("private-exif".utf8)))
        injected.append(segment(marker: 0xed, payload: Data("private-photoshop".utf8)))
        injected.append(segment(marker: 0xfe, payload: Data("private-comment".utf8)))
        injected.append(segment(marker: 0xe2, payload: Data("ICC_PROFILE".utf8)))
        injected.append(base.dropFirst(2))

        let sanitized = try AIReviewPreviewEncoder.strippingPrivateMetadataSegments(injected)
        let markers = try headerMarkers(in: sanitized)

        XCTAssertFalse(markers.contains(0xe1))
        XCTAssertFalse(markers.contains(0xed))
        XCTAssertFalse(markers.contains(0xfe))
        XCTAssertTrue(markers.contains(0xe2), "ICC APP2 is image data, not private metadata")
        XCTAssertNotNil(CGImageSourceCreateWithData(sanitized as CFData, nil))
    }

    func testSanitizerAlsoStripsCommentAfterEntropyCodedScan() throws {
        let base = try AIReviewPreviewEncoder.jpegData(for: try solidImage())
        let bytes = [UInt8](base)
        guard bytes.count >= 2, bytes[bytes.count - 2] == 0xff, bytes.last == 0xd9 else {
            return XCTFail("fixture JPEG has no EOI marker")
        }
        var injected = Data(bytes.dropLast(2))
        injected.append(segment(marker: 0xfe, payload: Data("late-private-comment".utf8)))
        injected.append(contentsOf: [0xff, 0xd9])

        let sanitized = try AIReviewPreviewEncoder.strippingPrivateMetadataSegments(injected)

        XCTAssertFalse(try headerMarkersAcrossScans(in: sanitized).contains(0xfe))
        XCTAssertNotNil(CGImageSourceCreateWithData(sanitized as CFData, nil))
    }

    private func solidImage() throws -> CGImage {
        guard let context = CGContext(
            data: nil,
            width: 32,
            height: 24,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 32, height: 24))
        guard let image = context.makeImage() else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        return image
    }

    private func segment(marker: UInt8, payload: Data) -> Data {
        let length = payload.count + 2
        var data = Data([0xff, marker, UInt8(length >> 8), UInt8(length & 0xff)])
        data.append(payload)
        return data
    }

    private func headerMarkers(in data: Data) throws -> [UInt8] {
        let bytes = [UInt8](data)
        guard bytes.count >= 4, bytes[0] == 0xff, bytes[1] == 0xd8 else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        var markers: [UInt8] = []
        var cursor = 2
        while cursor < bytes.count {
            guard bytes[cursor] == 0xff else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            while cursor < bytes.count, bytes[cursor] == 0xff { cursor += 1 }
            guard cursor < bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let marker = bytes[cursor]
            markers.append(marker)
            if marker == 0xda || marker == 0xd9 { return markers }
            if marker == 0x01 || (0xd0...0xd7).contains(marker) {
                cursor += 1
                continue
            }
            guard cursor + 2 < bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let length = Int(bytes[cursor + 1]) << 8 | Int(bytes[cursor + 2])
            guard length >= 2, cursor + 1 + length <= bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            cursor += 1 + length
        }
        throw AIReviewPreviewEncodingError.cannotEncodePreview
    }

    private func headerMarkersAcrossScans(in data: Data) throws -> [UInt8] {
        let bytes = [UInt8](data)
        guard bytes.count >= 4, bytes[0] == 0xff, bytes[1] == 0xd8 else {
            throw AIReviewPreviewEncodingError.cannotEncodePreview
        }
        var markers: [UInt8] = []
        var cursor = 2
        var insideScan = false
        while cursor < bytes.count {
            if insideScan {
                while cursor < bytes.count {
                    guard bytes[cursor] == 0xff else {
                        cursor += 1
                        continue
                    }
                    let markerStart = cursor
                    while cursor < bytes.count, bytes[cursor] == 0xff { cursor += 1 }
                    guard cursor < bytes.count else {
                        throw AIReviewPreviewEncodingError.cannotEncodePreview
                    }
                    if bytes[cursor] == 0x00 || (0xd0...0xd7).contains(bytes[cursor]) {
                        cursor += 1
                        continue
                    }
                    cursor = markerStart
                    insideScan = false
                    break
                }
                continue
            }
            guard bytes[cursor] == 0xff else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            while cursor < bytes.count, bytes[cursor] == 0xff { cursor += 1 }
            guard cursor < bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let marker = bytes[cursor]
            markers.append(marker)
            if marker == 0xd9 { return markers }
            if marker == 0x01 || (0xd0...0xd7).contains(marker) {
                cursor += 1
                continue
            }
            guard cursor + 2 < bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            let length = Int(bytes[cursor + 1]) << 8 | Int(bytes[cursor + 2])
            guard length >= 2, cursor + 1 + length <= bytes.count else {
                throw AIReviewPreviewEncodingError.cannotEncodePreview
            }
            cursor += 1 + length
            if marker == 0xda { insideScan = true }
        }
        throw AIReviewPreviewEncodingError.cannotEncodePreview
    }
}
