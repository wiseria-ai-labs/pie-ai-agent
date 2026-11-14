// Guard first: drop hosts left by older (orphaned) instances before this
// instance draws anything.
import { startInstanceGuard } from "./instance-guard";
import { detachSelectionListener } from "./quote/selection-listener";
import "./quote";
import "./overlay";
import { attachSubscribeBridge } from "./subscribe-bridge";

startInstanceGuard(detachSelectionListener);
attachSubscribeBridge();
