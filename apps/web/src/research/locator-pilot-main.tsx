import { createRoot } from "react-dom/client";
import { LocatorLocalPilot } from "./LocatorLocalPilot";
import "./locator-pilot.css";

// The development-only locator-pilot.html entry is intentionally NOT
// imported by the production app's index.html / App.tsx / main.tsx.
const mount = document.getElementById("root");
if (!mount) throw new Error("LOCATOR_PILOT_ROOT_MISSING");
createRoot(mount).render(<LocatorLocalPilot />);
