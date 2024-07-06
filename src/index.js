import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = 75;
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  const watermarkPath = '/directus/extensions/directus-extension-sane-image-size/watermark.png';

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
      const transformation = getTransformation(payload.type, quality, maxSize);
      if (transformation !== undefined) {
        try {
          const serviceOptions = { ...context, knex: context.database };
          const assets = new AssetsService(serviceOptions);
          const files = new FilesService(serviceOptions);

          // Get the asset with the applied transformation
          const { stream: transformedStream, stat } = await assets.getAsset(key, transformation);
          
          // Convert the transformed stream to a buffer
          const transformedBuffer = await streamToBuffer(transformedStream);

          // Apply watermark
          const watermarkedBuffer = await applyWatermark(transformedBuffer, watermarkPath, logger, context.sharp);

          if (stat.size < payload.filesize) {
            await sleep(4000);

            delete payload.width;
            delete payload.height;
            delete payload.size;

            files.uploadOne(
              watermarkedBuffer,
              {
                ...payload,
                optimized: true,
                type: 'image/avif',
              },
              key,
              { emitEvents: false }
            );
          }
        } catch (error) {
          logger.error(`Error processing image: ${error.message}`);
        }
      }
    }
  });
});

async function applyWatermark(inputBuffer, watermarkPath, logger, sharp) {
  try {
    const image = sharp(inputBuffer);
    const watermark = sharp(watermarkPath);

    const imageMetadata = await image.metadata();

    const resizedWatermark = await watermark
      .resize(imageMetadata.width, imageMetadata.height, { fit: 'fill' })
      .toBuffer();

    return image
      .composite([
        {
          input: resizedWatermark,
          blend: 'over',
        },
      ])
      .toBuffer();
  } catch (error) {
    logger.error(`Error applying watermark: ${error.message}`);
    return inputBuffer;
  }
}

function getTransformation(type, quality, maxSize) {
  const format = type.split("/")[1] ?? "";
  if (["jpg", "jpeg", "png", "webp", "avif"].includes(format)) {
    return {
      transformationParams: {
        format: 'avif',
        quality,
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
        transforms: [
          ['withMetadata'],
          ['avif', { quality }],
        ],
      },
    };
  }
  return undefined;
}

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
