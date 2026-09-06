import CoreGraphics
import CoreText
import CoreVideo
import CryptoKit
import Foundation
import ImageIO
import Vision

struct ReferenceSheetPairInput: Codable, Equatable, Sendable {
    let anchorID: String
    let leftID: String
    let rightID: String
    let leftLabel: String
    let rightLabel: String
    let leftFaceCritical: Bool
    let rightFaceCritical: Bool
    let leftFaceFocus: ReferenceSheetFaceFocus?
    let rightFaceFocus: ReferenceSheetFaceFocus?

    enum CodingKeys: String, CodingKey {
        case anchorID = "anchor_id"
        case leftID = "left_id"
        case rightID = "right_id"
        case leftLabel = "left_label"
        case rightLabel = "right_label"
        case leftFaceCritical = "left_face_critical"
        case rightFaceCritical = "right_face_critical"
        case leftFaceFocus = "left_face_focus"
        case rightFaceFocus = "right_face_focus"
    }
}

struct ReferenceSheetFaceFocus: Codable, Equatable, Sendable {
    /// Normalized center in the visually upright image; y uses a top-left origin.
    let centerX: Double
    let centerY: Double
    /// Square crop side as a fraction of the image's shorter pixel edge.
    let sideFraction: Double

    enum CodingKeys: String, CodingKey {
        case centerX = "center_x"
        case centerY = "center_y"
        case sideFraction = "side_fraction"
    }
}

struct ReferenceSheetCellReport: Equatable, Sendable {
    let cell: Int
    let label: String
    let faceCritical: Bool
    let primaryFaceShortEdgePixels: Int?
    let faceRegionSource: String?

    var dictionary: [String: Any] {
        var value: [String: Any] = [
            "cell": cell,
            "label": label,
            "face_critical": faceCritical,
        ]
        if let primaryFaceShortEdgePixels {
            value["primary_face_short_edge_pixels"] = primaryFaceShortEdgePixels
        } else {
            value["primary_face_short_edge_pixels"] = NSNull()
        }
        if let faceRegionSource {
            value["face_region_source"] = faceRegionSource
        } else {
            value["face_region_source"] = NSNull()
        }
        return value
    }
}

struct ReferenceSheetCellIdentity: Equatable, Sendable {
    let cell: Int
    let anchorID: String?
    let slot: String
    let anonymousID: String
    let sourcePreviewSHA256: String

    var dictionary: [String: Any] {
        [
            "cell": cell,
            "anchor_id": anchorID ?? NSNull(),
            "slot": slot,
            "anonymous_id": anonymousID,
            "source_preview_sha256": sourcePreviewSHA256,
        ]
    }
}

struct ReferenceSheetOutput: Sendable {
    let protocolID: String
    let width: Int
    let height: Int
    let pairCount: Int
    let assetCount: Int
    let jpegData: Data
    let cells: [ReferenceSheetCellReport]
    let sourcePreviewHashes: [String]
    let orderedCellIdentity: [ReferenceSheetCellIdentity]

    var dictionary: [String: Any] {
        [
            "layout_protocol": protocolID,
            "width": width,
            "height": height,
            "pair_count": pairCount,
            "asset_count": assetCount,
            "bytes": jpegData.count,
            "jpeg_sha256": SHA256.hash(data: jpegData).map { String(format: "%02x", $0) }.joined(),
            "jpeg_base64": jpegData.base64EncodedString(),
            "cells": cells.map(\.dictionary),
            "source_preview_sha256": sourcePreviewHashes,
            "ordered_cell_identity": orderedCellIdentity.map(\.dictionary),
        ]
    }
}

enum ReferenceSheetEncodingError: LocalizedError {
    case invalidInput(String)
    case cannotCreateCanvas

    var errorDescription: String? {
        switch self {
        case let .invalidInput(message): message
        case .cannotCreateCanvas: "无法创建参考图版画布，未发送任何照片。"
        }
    }
}

private struct SheetCell {
    let image: CGImage
    let faceCrop: CGImage?
    let faceShortEdgeFractionInCrop: CGFloat?
    let faceRegionSource: String?
    let label: String
    let faceCritical: Bool
    let sourcePreviewHash: String
    let anchorID: String?
    let slot: String
    let anonymousID: String
}

enum ReferenceSheetEncoder {
    static let anchorGridProtocol = "anchor-grid-4x4-1024-explicit-focus-v3"
    static let candidatePairProtocol = "pair-side-by-side-3072x1536-face-inset-v2"
    private static let labelBandHeight = 96
    private static let cellInset = 16

    static func anchorSheet(
        pairs: [ReferenceSheetPairInput],
        index: AnonymousIndex
    ) throws -> ReferenceSheetOutput {
        guard !pairs.isEmpty, pairs.count <= 8 else {
            throw ReferenceSheetEncodingError.invalidInput("参考图版只允许 1...8 组成对锚点。")
        }
        let ids = pairs.flatMap { [$0.leftID, $0.rightID] }
        guard Set(ids).count == ids.count else {
            throw ReferenceSheetEncodingError.invalidInput("参考图版不得重复使用同一匿名照片。")
        }
        let anchorIDs = pairs.map(\.anchorID)
        guard Set(anchorIDs).count == anchorIDs.count else {
            throw ReferenceSheetEncodingError.invalidInput("参考图版的匿名锚点 ID 必须唯一。")
        }
        var cells: [SheetCell] = []
        for pair in pairs {
            try validateAnchorID(pair.anchorID)
            try validateLabel(pair.leftLabel, anchorID: pair.anchorID, slot: "A")
            try validateLabel(pair.rightLabel, anchorID: pair.anchorID, slot: "B")
            for (id, label, critical, focus, slot) in [
                (pair.leftID, pair.leftLabel, pair.leftFaceCritical, pair.leftFaceFocus, "A"),
                (pair.rightID, pair.rightLabel, pair.rightFaceCritical, pair.rightFaceFocus, "B"),
            ] {
                let sourceData = try VerifiedImageSource.load(id: id, index: index)
                cells.append(try sourceCell(
                    sourceData: sourceData,
                    label: label,
                    faceCritical: critical,
                    explicitFaceFocus: focus,
                    maximumPixelSize: 1_024,
                    anchorID: pair.anchorID,
                    slot: slot,
                    anonymousID: id
                ))
            }
        }
        return try render(
            cells: cells,
            columns: 4,
            rows: 4,
            cellWidth: 1_024,
            cellHeight: 1_024,
            protocolID: anchorGridProtocol,
            pairCount: pairs.count
        )
    }

    static func candidatePairSheet(
        firstID: String,
        secondID: String,
        firstFaceFocus: ReferenceSheetFaceFocus,
        secondFaceFocus: ReferenceSheetFaceFocus,
        firstExpectedOriginalSHA256: String,
        secondExpectedOriginalSHA256: String,
        index: AnonymousIndex
    ) throws -> ReferenceSheetOutput {
        guard firstID != secondID,
              index.byAnonymous[firstID] != nil,
              index.byAnonymous[secondID] != nil else {
            throw ReferenceSheetEncodingError.invalidInput("双候选图版要求两个不同且已知的匿名照片。")
        }
        let firstData = try VerifiedImageSource.load(
            id: firstID, index: index, expectedSHA256: firstExpectedOriginalSHA256
        )
        let secondData = try VerifiedImageSource.load(
            id: secondID, index: index, expectedSHA256: secondExpectedOriginalSHA256
        )
        let cells = try [
            sourceCell(
                sourceData: firstData, label: "FIRST", faceCritical: true,
                explicitFaceFocus: firstFaceFocus,
                maximumPixelSize: AIReviewPreviewSize.large.maximumPixelSize,
                anchorID: nil,
                slot: "FIRST",
                anonymousID: firstID
            ),
            sourceCell(
                sourceData: secondData, label: "SECOND", faceCritical: true,
                explicitFaceFocus: secondFaceFocus,
                maximumPixelSize: AIReviewPreviewSize.large.maximumPixelSize,
                anchorID: nil,
                slot: "SECOND",
                anonymousID: secondID
            ),
        ]
        return try render(
            cells: cells,
            columns: 2,
            rows: 1,
            cellWidth: 1_536,
            cellHeight: 1_536,
            protocolID: candidatePairProtocol,
            pairCount: 1
        )
    }

    private static func sourceCell(
        sourceData: Data,
        label: String,
        faceCritical: Bool,
        explicitFaceFocus: ReferenceSheetFaceFocus?,
        maximumPixelSize: Int,
        anchorID: String?,
        slot: String,
        anonymousID: String
    ) throws -> SheetCell {
        if let explicitFaceFocus, !isValid(focus: explicitFaceFocus) {
            throw ReferenceSheetEncodingError.invalidInput("显式人脸聚焦区域无效。")
        }
        let image = try AIReviewPreviewEncoder.thumbnailImage(
            for: sourceData, maximumPixelSize: maximumPixelSize
        )
        let faceDetailImage = faceCritical
            ? try AIReviewPreviewEncoder.thumbnailImage(for: sourceData, maximumPixelSize: 4_096)
            : nil
        let faceDetail = faceDetailImage.flatMap { detailImage in
            explicitFaceFocus.flatMap { explicitFocusCrop(image: detailImage, focus: $0) }
                ?? makeFaceCrop(image: detailImage)
        }
        let preview = try AIReviewPreviewEncoder.jpegData(for: image)
        let hash = SHA256.hash(data: preview).map { String(format: "%02x", $0) }.joined()
        return SheetCell(
            image: image,
            faceCrop: faceDetail?.image,
            faceShortEdgeFractionInCrop: faceDetail?.faceShortEdgeFraction,
            faceRegionSource: faceDetail?.source,
            label: label,
            faceCritical: faceCritical,
            sourcePreviewHash: hash,
            anchorID: anchorID,
            slot: slot,
            anonymousID: anonymousID
        )
    }

    private static func render(
        cells: [SheetCell],
        columns: Int,
        rows: Int,
        cellWidth: Int,
        cellHeight: Int,
        protocolID: String,
        pairCount: Int
    ) throws -> ReferenceSheetOutput {
        guard cells.count <= columns * rows else {
            throw ReferenceSheetEncodingError.invalidInput("图版容量不足。")
        }
        let width = columns * cellWidth
        let height = rows * cellHeight
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw ReferenceSheetEncodingError.cannotCreateCanvas
        }
        context.setFillColor(CGColor(gray: 0.08, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        var reports: [ReferenceSheetCellReport] = []
        for (position, cell) in cells.enumerated() {
            let column = position % columns
            let rowFromTop = position / columns
            let cellX = column * cellWidth
            let cellY = height - (rowFromTop + 1) * cellHeight
            let cellRect = CGRect(x: cellX, y: cellY, width: cellWidth, height: cellHeight)
            context.setFillColor(CGColor(gray: 0.13, alpha: 1))
            context.fill(cellRect.insetBy(dx: 4, dy: 4))

            let labelRect = CGRect(
                x: cellX + cellInset,
                y: cellY + cellHeight - labelBandHeight,
                width: cellWidth - cellInset * 2,
                height: labelBandHeight - 12
            )
            context.setFillColor(CGColor(gray: 0.96, alpha: 1))
            context.fill(CGRect(
                x: cellX + 4,
                y: cellY + cellHeight - labelBandHeight,
                width: cellWidth - 8,
                height: labelBandHeight - 4
            ))
            drawLabel(cell.label, in: labelRect, context: context)

            let contentRect = CGRect(
                x: cellX + cellInset,
                y: cellY + cellInset,
                width: cellWidth - cellInset * 2,
                height: cellHeight - labelBandHeight - cellInset * 2
            )
            let drawRect = aspectFit(
                sourceWidth: cell.image.width,
                sourceHeight: cell.image.height,
                inside: contentRect
            )
            context.interpolationQuality = .high
            context.draw(cell.image, in: drawRect)
            var insetFaceShortEdge: Int?
            if cell.faceCritical,
               let faceCrop = cell.faceCrop {
                let insetSize = min(contentRect.width, contentRect.height) * 0.38
                let insetRect = CGRect(
                    x: contentRect.maxX - insetSize - 8,
                    y: contentRect.minY + 8,
                    width: insetSize,
                    height: insetSize
                ).integral
                context.setFillColor(CGColor(gray: 1, alpha: 1))
                context.fill(insetRect.insetBy(dx: -6, dy: -6))
                context.draw(faceCrop, in: insetRect)
                if let faceFraction = cell.faceShortEdgeFractionInCrop {
                    insetFaceShortEdge = Int((insetSize * faceFraction).rounded(.down))
                }
            }
            let fullFrameFace = primaryFaceShortEdgePixels(image: cell.image, renderedIn: drawRect)
            reports.append(ReferenceSheetCellReport(
                cell: position + 1,
                label: cell.label,
                faceCritical: cell.faceCritical,
                primaryFaceShortEdgePixels: reportedFaceShortEdgePixels(
                    fullFrame: fullFrameFace,
                    inset: insetFaceShortEdge,
                    faceRegionSource: cell.faceRegionSource
                ),
                faceRegionSource: cell.faceRegionSource
            ))
        }
        guard let outputImage = context.makeImage() else {
            throw ReferenceSheetEncodingError.cannotCreateCanvas
        }
        let data = try AIReviewPreviewEncoder.jpegData(for: outputImage, compressionQuality: 0.88)
        return ReferenceSheetOutput(
            protocolID: protocolID,
            width: width,
            height: height,
            pairCount: pairCount,
            assetCount: cells.count,
            jpegData: data,
            cells: reports,
            sourcePreviewHashes: cells.map(\.sourcePreviewHash),
            orderedCellIdentity: cells.enumerated().map { position, cell in
                ReferenceSheetCellIdentity(
                    cell: position + 1,
                    anchorID: cell.anchorID,
                    slot: cell.slot,
                    anonymousID: cell.anonymousID,
                    sourcePreviewSHA256: cell.sourcePreviewHash
                )
            }
        )
    }

    private static func aspectFit(
        sourceWidth: Int,
        sourceHeight: Int,
        inside bounds: CGRect
    ) -> CGRect {
        let scale = min(
            bounds.width / CGFloat(sourceWidth),
            bounds.height / CGFloat(sourceHeight)
        )
        let width = CGFloat(sourceWidth) * scale
        let height = CGFloat(sourceHeight) * scale
        return CGRect(
            x: bounds.midX - width / 2,
            y: bounds.midY - height / 2,
            width: width,
            height: height
        ).integral
    }

    private static func drawLabel(_ text: String, in rect: CGRect, context: CGContext) {
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(
                "Helvetica-Bold" as CFString, 38, nil
            ),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(
                gray: 0.05, alpha: 1
            ),
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(
            string: text, attributes: attributes
        ))
        context.textPosition = CGPoint(x: rect.minX, y: rect.midY - 18)
        CTLineDraw(line, context)
    }

    private static func primaryFaceShortEdgePixels(
        image: CGImage,
        renderedIn drawRect: CGRect
    ) -> Int? {
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil,
              let face = request.results?.max(by: {
                  $0.boundingBox.width * $0.boundingBox.height
                      < $1.boundingBox.width * $1.boundingBox.height
              }) else { return nil }
        return renderedFaceShortEdgePixels(
            visionBoundingBox: face.boundingBox,
            renderedIn: drawRect
        )
    }

    static func renderedFaceShortEdgePixels(
        visionBoundingBox: CGRect,
        renderedIn drawRect: CGRect
    ) -> Int {
        let width = visionBoundingBox.width * drawRect.width
        let height = visionBoundingBox.height * drawRect.height
        return Int(min(width, height).rounded(.down))
    }

    static func reportedFaceShortEdgePixels(
        fullFrame: Int?,
        inset: Int?,
        faceRegionSource: String?
    ) -> Int? {
        if faceRegionSource == "explicit_focus_unverified"
            || faceRegionSource == "person_head_unverified" {
            return nil
        }
        return [fullFrame, inset].compactMap { $0 }.max()
    }

    private struct FaceCrop {
        let image: CGImage
        let faceShortEdgeFraction: CGFloat?
        let source: String
    }

    private static func makeFaceCrop(image: CGImage) -> FaceCrop? {
        if let face = largestFace(in: image) {
            return cropAroundFace(image: image, boundingBox: face, source: "direct_face")
        }

        // Travel portraits often contain a face that is too small for a whole-frame
        // face request. Use the person's upper region only as a search window, then
        // require a second face request inside that window. The human box itself is
        // never treated as proof that a readable face exists.
        guard let person = largestHuman(in: image),
              let headSearchImage = cropHeadSearchRegion(image: image, person: person) else {
            return nil
        }
        if let localFace = largestFace(in: headSearchImage) {
            return cropAroundFace(
                image: headSearchImage,
                boundingBox: localFace,
                source: "person_then_face"
            )
        }
        // Preserve the locally inferred head window for mandatory visual QA,
        // but keep its measured face size nil so it can never auto-mint PASS.
        return FaceCrop(
            image: headSearchImage,
            faceShortEdgeFraction: nil,
            source: "person_head_unverified"
        )
    }

    private static func largestFace(in image: CGImage) -> CGRect? {
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        if (try? handler.perform([request])) != nil,
           let face = request.results?.max(by: {
                  $0.boundingBox.width * $0.boundingBox.height
                      < $1.boundingBox.width * $1.boundingBox.height
           }) {
            return face.boundingBox
        }

        return nil
    }

    private static func largestHuman(in image: CGImage) -> CGRect? {
        let request = VNDetectHumanRectanglesRequest()
        request.upperBodyOnly = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        if (try? handler.perform([request])) != nil,
           let person = request.results?.max(by: {
                  $0.boundingBox.width * $0.boundingBox.height
                      < $1.boundingBox.width * $1.boundingBox.height
           }) {
            return person.boundingBox
        }
        return personSegmentationBoundingBox(in: image)
    }

    private static func personSegmentationBoundingBox(in image: CGImage) -> CGRect? {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil,
              let buffer = request.results?.first?.pixelBuffer else { return nil }
        return maskBoundingBox(buffer)
    }

    private static func maskBoundingBox(_ buffer: CVPixelBuffer) -> CGRect? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8 else {
            return nil
        }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        guard width > 0, height > 0 else { return nil }

        let pixels = base.assumingMemoryBound(to: UInt8.self)
        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        for y in 0..<height {
            let row = pixels.advanced(by: y * bytesPerRow)
            for x in 0..<width where row[x] >= 64 {
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return CGRect(
            x: CGFloat(minX) / CGFloat(width),
            y: CGFloat(height - 1 - maxY) / CGFloat(height),
            width: CGFloat(maxX - minX + 1) / CGFloat(width),
            height: CGFloat(maxY - minY + 1) / CGFloat(height)
        )
    }

    private static func cropHeadSearchRegion(image: CGImage, person: CGRect) -> CGImage? {
        let personPixels = pixelRect(fromVisionBox: person, image: image)
        let side = max(personPixels.width * 0.9, personPixels.height * 0.36)
        let center = CGPoint(
            x: personPixels.midX,
            y: personPixels.minY + personPixels.height * 0.18
        )
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let cropRect = clampedSquare(center: center, requestedSide: side, bounds: bounds)
        guard cropRect.width > 0, cropRect.height > 0 else { return nil }
        return image.cropping(to: cropRect)
    }

    private static func cropAroundFace(
        image: CGImage,
        boundingBox: CGRect,
        source: String
    ) -> FaceCrop? {
        let rawFace = pixelRect(fromVisionBox: boundingBox, image: image)

        let side = max(rawFace.width, rawFace.height) * 2.4
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let cropRect = clampedSquare(
            center: CGPoint(x: rawFace.midX, y: rawFace.midY),
            requestedSide: side,
            bounds: bounds
        )
        guard cropRect.width > 0, cropRect.height > 0,
              let cropped = image.cropping(to: cropRect) else { return nil }
        return FaceCrop(
            image: cropped,
            faceShortEdgeFraction: min(rawFace.width / cropRect.width, rawFace.height / cropRect.height),
            source: source
        )
    }

    private static func explicitFocusCrop(
        image: CGImage,
        focus: ReferenceSheetFaceFocus
    ) -> FaceCrop? {
        guard isValid(focus: focus) else {
            return nil
        }
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let side = min(width, height) * CGFloat(focus.sideFraction)
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        let cropRect = clampedSquare(
            center: CGPoint(
                x: width * CGFloat(focus.centerX),
                y: height * CGFloat(focus.centerY)
            ),
            requestedSide: side,
            bounds: bounds
        )
        guard cropRect.width > 0, cropRect.height > 0,
              let cropped = image.cropping(to: cropRect) else { return nil }
        return FaceCrop(
            image: cropped,
            faceShortEdgeFraction: nil,
            source: "explicit_focus_unverified"
        )
    }

    static func clampedSquare(
        center: CGPoint,
        requestedSide: CGFloat,
        bounds: CGRect
    ) -> CGRect {
        let maximumSide = floor(min(bounds.width, bounds.height))
        let side = min(max(1, floor(requestedSide)), maximumSide)
        let proposedX = (center.x - side / 2).rounded(.toNearestOrAwayFromZero)
        let proposedY = (center.y - side / 2).rounded(.toNearestOrAwayFromZero)
        let x = min(max(proposedX, ceil(bounds.minX)), floor(bounds.maxX - side))
        let y = min(max(proposedY, ceil(bounds.minY)), floor(bounds.maxY - side))
        return CGRect(x: x, y: y, width: side, height: side)
    }

    private static func isValid(focus: ReferenceSheetFaceFocus) -> Bool {
        focus.centerX.isFinite && focus.centerY.isFinite && focus.sideFraction.isFinite
            && focus.centerX >= 0 && focus.centerX <= 1
            && focus.centerY >= 0 && focus.centerY <= 1
            && focus.sideFraction >= 0.05 && focus.sideFraction <= 0.8
    }

    private static func validateAnchorID(_ anchorID: String) throws {
        let suffix = anchorID.dropFirst("anchor-".count)
        guard anchorID.hasPrefix("anchor-"), anchorID.count == 10,
              suffix.count == 3, suffix.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            throw ReferenceSheetEncodingError.invalidInput(
                "锚点 ID 必须使用 anchor-000 形式的匿名标识。"
            )
        }
    }

    private static func validateLabel(
        _ label: String,
        anchorID: String,
        slot: String
    ) throws {
        let prefix = "\(anchorID) \(slot) • "
        guard label.hasPrefix(prefix), label.utf8.count <= 64 else {
            throw ReferenceSheetEncodingError.invalidInput("图版标签与锚点 ID/槽位不一致。")
        }
        let verdict = label.dropFirst(prefix.count)
        let allowed = verdict.unicodeScalars.allSatisfy { scalar in
            let value = scalar.value
            return value == 0x20 || value == 0x2d || value == 0x5f
                || (0x30...0x39).contains(value) || (0x41...0x5a).contains(value)
        }
        guard !verdict.isEmpty, verdict.count <= 32,
              verdict == verdict.trimmingCharacters(in: .whitespaces), allowed else {
            throw ReferenceSheetEncodingError.invalidInput("图版标签只允许简短的匿名大写决策文本。")
        }
    }

    private static func pixelRect(fromVisionBox box: CGRect, image: CGImage) -> CGRect {
        let imageWidth = CGFloat(image.width)
        let imageHeight = CGFloat(image.height)
        return CGRect(
            x: box.minX * imageWidth,
            y: (1 - box.maxY) * imageHeight,
            width: box.width * imageWidth,
            height: box.height * imageHeight
        )
    }
}
