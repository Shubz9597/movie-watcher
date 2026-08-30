export const VOD_BASE = "http://localhost:4001";
export const RESUME_TOLERANCE_SECONDS = 3;
export const RESUME_VERIFY_TIMEOUT_MS = 90000;
export const PLAYER_WINDOW_CHROME_HEIGHT = 40;
export const VIDEO_HOST_OVERSCAN = 2;

export const ASPECT_MODES = [
  { id: "fill", label: "Fill", aspect: "-1", panscan: 1, zoom: 0 },
  { id: "fit", label: "Fit", aspect: "-1", panscan: 0, zoom: 0 },
  { id: "16:9", label: "16:9", aspect: "16:9", panscan: 0, zoom: 0 },
  { id: "4:3", label: "4:3", aspect: "4:3", panscan: 0, zoom: 0 },
  { id: "cinema", label: "Cinema 2.35:1", aspect: "2.35:1", panscan: 0, zoom: 0 },
  { id: "zoom", label: "Zoomed fill", aspect: "-1", panscan: 1, zoom: 0.14 },
];
