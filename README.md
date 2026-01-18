# Image Suite

This Directus extension, originally forked from
[directus-extension-sane-image-size](https://github.com/martabitbrain/directus-extension-sane-image-size),
resizes oversized images on upload, converts them to AVIF, applies a watermark
when possible, and triggers thumbnail generation.

Features:

- Format conversion to AVIF
- Watermarking (centered)
- Automatic thumbnail warm-up

## Installation

1. Install via one of the following methods:
   - Directus Marketplace (if available).
   - Clone (and build) this repo inside your `extensions` Directus directory.
   - Install into your project via npm.
2. If desired, edit the `.env` file of your Directus installation to set:
   ```bash
   # Default if not specified
   EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE=1920
   ```
3. Reload your Directus process. The following message should appear:
   ```log
   [12:39:24.309] INFO: Loaded extensions: directus-extension-sane-image-size
   ```

## How it works

On each `files.upload` event, the extension processes one file at a time:

- Reads the uploaded file record to get dimensions and type.
- Skips unsupported types (only `jpg`, `jpeg`, `png`, `webp` are transformed).
- Resizes to fit within `MAXSIZE` while keeping aspect ratio (no enlargement).
- Converts to AVIF at a fixed quality of `75`.
- Applies a centered watermark if a suitable watermark image is available.
- Re-uploads the file (same file ID) with updated metadata and `optimized: true`.
- Waits/throttles between files (intentional to keep a small server responsive).
- Warms a thumbnail preset (`carousel`) in WebP and AVIF.

## Configuration

Environment variables:

- `EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE` (default `1920`): Maximum width/height for resize.

Hardcoded settings in `src/index.js`:

- Quality is fixed to `75` (AVIF).
- Watermarks are loaded from `/directus/extensions/directus-extension-sane-image-size/`.
- Thumbnail warm-up hits `https://bluehorizoncondospattaya.com/assets` with preset `carousel`.
- Processing is single-file with throttled waits between items.

If you need to change any of the hardcoded values, update `src/index.js` and
rebuild the extension.

## Notice

This extension contains hardcoded features. Modifications to the code are
necessary for reuse in other projects.

## Known issues

### Preview not optimized

Since the `files.upload` event is async, you will not see the new image size
right away on the content edition interface. If you save the content and reload,
you will see the image with the updated file size and dimensions.

### Image is too large to be transformed, or image size couldn't be determined

Check your image is not bigger than the default value specified at
`ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION` (See
https://docs.directus.io/self-hosted/config-options.html#assets). If you need to
handle files bigger than that value, please update your `.env` file accordingly.

### Can I specify the target filesize instead of the target size?

Sharp library (the one used by Directus to handle the images) does not support
that feature. The only way could be trying several optimization configurations
until the desired size is reached but that is time-consuming and this extension
might not be the best place to do so.

## Authors

- Christian Fuss (initial snippet idea)
- Marta Moros Batlle (conversion into Directus plugin)
- Resumane (with help from an army of LLMs)
