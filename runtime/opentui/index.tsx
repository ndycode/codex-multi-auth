import { render } from "@opentui/solid";
import { OpenTuiShellProof, loadInitialShellState } from "./shell";

const initialState = await loadInitialShellState();

await render(() => <OpenTuiShellProof initialState={initialState} />);
