// Read an installed application's icon without opening or automating the app.
ObjC.import("AppKit");
function run(argv) {
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  var bitmap =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null,
      64,
      64,
      8,
      4,
      true,
      false,
      $.NSDeviceRGBColorSpace,
      0,
      0,
    );
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(
    $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap),
  );
  icon.drawInRectFromRectOperationFractionRespectFlippedHints(
    $.NSMakeRect(0, 0, 64, 64),
    $.NSZeroRect,
    $.NSCompositingOperationSourceOver,
    1,
    true,
    $.NSDictionary.dictionary,
  );
  $.NSGraphicsContext.restoreGraphicsState;
  return ObjC.unwrap(
    bitmap
      .representationUsingTypeProperties(
        $.NSPNGFileType,
        $.NSDictionary.dictionary,
      )
      .base64EncodedStringWithOptions(0),
  );
}
