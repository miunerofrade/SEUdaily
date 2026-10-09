import { conversationsRoutes } from "./app-routes-conversations.js";
import { scheduleRoutes } from "./app-routes-schedule.js";
import { libraryRoutes } from "./app-routes-library.js";
import { settingsRoutes } from "./app-routes-settings.js";
export { safeLibraryTarget } from "./library-files.js";

export const appRoutes = [
  ...conversationsRoutes,
  ...scheduleRoutes,
  ...libraryRoutes,
  ...settingsRoutes,
];
