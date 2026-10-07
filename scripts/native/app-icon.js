// Read installed applications' icons (absolute paths) or the icon Finder shows
// for a file type ("folder", "file" or an extension), without opening anything.
// One line of base64 PNG per argument, in order; an empty line when unreadable.
ObjC.import("AppKit");
var SIZE = 128; // Retina-sharp at the 48–64pt the phone shows.
var TYPES = { folder: "public.folder", file: "public.data" };
function icon(target) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var image =
    target.charAt(0) === "/"
      ? workspace.iconForFile(target)
      : workspace.iconForFileType(TYPES[target] || target);
  var bitmap =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null,
      SIZE,
      SIZE,
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
  image.drawInRectFromRectOperationFractionRespectFlippedHints(
    $.NSMakeRect(0, 0, SIZE, SIZE),
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
function run(argv) {
  return argv
    .map(function (file) {
      try {
        return icon(file);
      } catch (e) {
        return "";
      }
    })
    .join("\n");
}
