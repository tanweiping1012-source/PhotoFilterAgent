import CoreGraphics
import CryptoKit
import Foundation
import XCTest
@testable import photofilter

final class ReferenceSheetEncoderTests: XCTestCase {
    func testRejectsEmptyDuplicateAndNonAnonymousAnchorIDs() throws {
        let index = AnonymousIndex(root: "/unused", byAnonymous: [:])

        for invalidID in ["", "anchor-01", "../anchor-001", "anchor-٠٠١"] {
            XCTAssertThrowsError(try ReferenceSheetEncoder.anchorSheet(
                pairs: [pair(anchorID: invalidID)], index: index
            ))
        }

        let duplicate = [
            pair(anchorID: "anchor-001", leftID: "p001", rightID: "p002"),
            pair(anchorID: "anchor-001", leftID: "p003", rightID: "p004"),
        ]
        XCTAssertThrowsError(try ReferenceSheetEncoder.anchorSheet(pairs: duplicate, index: index))
    }

    func testRejectsMismatchedOrUnsafeLabelsBeforeReadingAnySource() throws {
        let index = AnonymousIndex(root: "/unused", byAnonymous: [:])
        let maliciousLabels = [
            "anchor-001 B • KEEP",
            "anchor-001 A • KEEP\n/private.jpg",
            "anchor-001 A • KEEP‮GPJ",
            "anchor-001 A • keep",
            "anchor-001 A • \(String(repeating: "A", count: 40))",
        ]

        for label in maliciousLabels {
            let input = pair(anchorID: "anchor-001", leftLabel: label)
            XCTAssertThrowsError(try ReferenceSheetEncoder.anchorSheet(
                pairs: [input], index: index
            ), "unsafe label should fail closed: \(label.debugDescription)")
        }
    }

    func testEdgeClampingAlwaysReturnsAnInBoundsPixelSquare() {
        let bounds = CGRect(x: 0, y: 0, width: 400, height: 200)
        let cases = [
            CGPoint(x: -50, y: -50),
            CGPoint(x: 0, y: 0),
            CGPoint(x: 400, y: 200),
            CGPoint(x: 900, y: 900),
        ]

        for center in cases {
            let crop = ReferenceSheetEncoder.clampedSquare(
                center: center, requestedSide: 101.9, bounds: bounds
            )
            XCTAssertEqual(crop.width, crop.height)
            XCTAssertEqual(crop.width, 101)
            XCTAssertGreaterThanOrEqual(crop.minX, bounds.minX)
            XCTAssertGreaterThanOrEqual(crop.minY, bounds.minY)
            XCTAssertLessThanOrEqual(crop.maxX, bounds.maxX)
            XCTAssertLessThanOrEqual(crop.maxY, bounds.maxY)
            XCTAssertEqual(crop.minX, floor(crop.minX))
            XCTAssertEqual(crop.minY, floor(crop.minY))
        }
    }

    func testFaceMetricUsesBoundingBoxShortEdgeRatherThanAreaEquivalent() {
        let measured = ReferenceSheetEncoder.renderedFaceShortEdgePixels(
            visionBoundingBox: CGRect(x: 0.1, y: 0.1, width: 0.5, height: 0.1),
            renderedIn: CGRect(x: 0, y: 0, width: 800, height: 1_000)
        )

        XCTAssertEqual(measured, 100)
    }

    func testUnverifiedFocusCanNeverAutoPassFromFullFrameMetric() {
        XCTAssertNil(ReferenceSheetEncoder.reportedFaceShortEdgePixels(
            fullFrame: 800, inset: nil, faceRegionSource: "explicit_focus_unverified"
        ))
        XCTAssertNil(ReferenceSheetEncoder.reportedFaceShortEdgePixels(
            fullFrame: 800, inset: nil, faceRegionSource: "person_head_unverified"
        ))
        XCTAssertEqual(ReferenceSheetEncoder.reportedFaceShortEdgePixels(
            fullFrame: 80, inset: 120, faceRegionSource: "direct_face"
        ), 120)
    }

    func testOutputBindsOrderedAnchorSlotAnonymousIDAndSourceHash() throws {
        let fixture = try imageFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let index = AnonymousIndex(
            root: fixture.root.path,
            byAnonymous: ["p001": fixture.first.path, "p002": fixture.second.path]
        )

        let output = try ReferenceSheetEncoder.anchorSheet(
            pairs: [pair(anchorID: "anchor-001")], index: index
        )
        let firstHash = try sourcePreviewHash(fixture.first)
        let secondHash = try sourcePreviewHash(fixture.second)

        XCTAssertEqual(output.sourcePreviewHashes, [firstHash, secondHash])
        XCTAssertEqual(output.orderedCellIdentity, [
            ReferenceSheetCellIdentity(
                cell: 1, anchorID: "anchor-001", slot: "A",
                anonymousID: "p001", sourcePreviewSHA256: firstHash
            ),
            ReferenceSheetCellIdentity(
                cell: 2, anchorID: "anchor-001", slot: "B",
                anonymousID: "p002", sourcePreviewSHA256: secondHash
            ),
        ])
    }

    func testCandidatePairRequiresAndRendersBothFrozenFocusCrops() throws {
        let fixture = try imageFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let index = AnonymousIndex(
            root: fixture.root.path,
            byAnonymous: ["p001": fixture.first.path, "p002": fixture.second.path]
        )
        let firstFocus = ReferenceSheetFaceFocus(centerX: 0.35, centerY: 0.40, sideFraction: 0.40)
        let secondFocus = ReferenceSheetFaceFocus(centerX: 0.65, centerY: 0.45, sideFraction: 0.35)

        let output = try ReferenceSheetEncoder.candidatePairSheet(
            firstID: "p001",
            secondID: "p002",
            firstFaceFocus: firstFocus,
            secondFaceFocus: secondFocus,
            firstExpectedOriginalSHA256: try originalHash(fixture.first),
            secondExpectedOriginalSHA256: try originalHash(fixture.second),
            index: index
        )

        XCTAssertEqual(output.protocolID, ReferenceSheetEncoder.candidatePairProtocol)
        XCTAssertEqual(output.cells.map(\.label), ["FIRST", "SECOND"])
        XCTAssertEqual(output.cells.map(\.faceRegionSource), [
            "explicit_focus_unverified", "explicit_focus_unverified",
        ])
        XCTAssertEqual(output.cells.map(\.primaryFaceShortEdgePixels), [nil, nil])
        XCTAssertEqual(output.orderedCellIdentity.map(\.slot), ["FIRST", "SECOND"])
        XCTAssertEqual(output.orderedCellIdentity.map(\.anonymousID), ["p001", "p002"])
    }

    func testCandidatePairRejectsChangedOriginalContentBeforeRendering() throws {
        let fixture = try imageFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let index = AnonymousIndex(
            root: fixture.root.path,
            byAnonymous: ["p001": fixture.first.path, "p002": fixture.second.path]
        )
        let focus = ReferenceSheetFaceFocus(centerX: 0.5, centerY: 0.5, sideFraction: 0.4)

        XCTAssertThrowsError(try ReferenceSheetEncoder.candidatePairSheet(
            firstID: "p001",
            secondID: "p002",
            firstFaceFocus: focus,
            secondFaceFocus: focus,
            firstExpectedOriginalSHA256: String(repeating: "0", count: 64),
            secondExpectedOriginalSHA256: try originalHash(fixture.second),
            index: index
        )) { error in
            XCTAssertEqual(error as? VerifiedImageSourceError, .contentIdentityChanged)
        }
    }

    private func pair(
        anchorID: String,
        leftID: String = "p001",
        rightID: String = "p002",
        leftLabel: String? = nil
    ) -> ReferenceSheetPairInput {
        ReferenceSheetPairInput(
            anchorID: anchorID,
            leftID: leftID,
            rightID: rightID,
            leftLabel: leftLabel ?? "\(anchorID) A • KEEP",
            rightLabel: "\(anchorID) B • REJECT",
            leftFaceCritical: false,
            rightFaceCritical: false,
            leftFaceFocus: nil,
            rightFaceFocus: nil
        )
    }

    private func imageFixture() throws -> (root: URL, first: URL, second: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("photofilter-reference-sheet-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let first = root.appendingPathComponent("first.jpg")
        let second = root.appendingPathComponent("second.jpg")
        try AIReviewPreviewEncoder.jpegData(for: try solidImage(red: 0.8, green: 0.1)).write(to: first)
        try AIReviewPreviewEncoder.jpegData(for: try solidImage(red: 0.1, green: 0.8)).write(to: second)
        return (root, first, second)
    }

    private func solidImage(red: CGFloat, green: CGFloat) throws -> CGImage {
        guard let context = CGContext(
            data: nil,
            width: 64,
            height: 48,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw ReferenceSheetEncodingError.cannotCreateCanvas }
        context.setFillColor(CGColor(red: red, green: green, blue: 0.2, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        guard let image = context.makeImage() else {
            throw ReferenceSheetEncodingError.cannotCreateCanvas
        }
        return image
    }

    private func sourcePreviewHash(_ url: URL) throws -> String {
        let image = try AIReviewPreviewEncoder.thumbnailImage(for: url, maximumPixelSize: 1_024)
        let preview = try AIReviewPreviewEncoder.jpegData(for: image)
        return SHA256.hash(data: preview).map { String(format: "%02x", $0) }.joined()
    }

    private func originalHash(_ url: URL) throws -> String {
        VerifiedImageSource.sha256(try Data(contentsOf: url))
    }
}
