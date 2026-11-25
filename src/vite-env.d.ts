/// <reference types="vite/client" />

interface Window {
  museumDrive?: import('./driveAttachments').DriveBridge;
  museumPrinting?: {
    createPreview: () => Promise<ArrayBuffer>;
    print: (geometry: import('./printLayout').PrintGeometry, options?: { actualSize: boolean }) => Promise<{ success: boolean; reason?: string }>;
  };
}
