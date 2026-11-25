const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_DATA_URL_LENGTH = 400_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 1800;

export const PRINT_IMAGE_TYPES = IMAGE_TYPES.join(',');

export function isPrintImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DATA_URL_LENGTH
    && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function toDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });
}

export async function preparePrintImage(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose an image under 20 MB.');

  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('Could not open this image. Choose a readable PNG, JPEG, or WebP file.');
    }

    const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
    if (largestSide <= MAX_DIMENSION && file.size < MAX_DATA_URL_LENGTH * 0.74) {
      const original = await toDataUrl(file);
      if (isPrintImage(original)) return original;
    }

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the print image.');
    for (let size = Math.min(largestSide, MAX_DIMENSION);; size *= 0.75) {
      const scale = size / largestSide;
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const compressed = canvas.toDataURL('image/webp', 0.9);
      if (isPrintImage(compressed)) return compressed;
      if (size <= 360) break;
    }
    throw new Error('This image is too large to save. Choose a smaller image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
