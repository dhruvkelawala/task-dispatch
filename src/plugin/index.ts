// @ts-expect-error Legacy JS plugin source is imported for parity.
import setup from "../../index.mjs";

export default setup;

export * from "./types";
export * from "./db";
export * from "./config";
export * from "./dispatch";
export * from "./qa";
export * from "./notify";
export * from "./scheduler";
