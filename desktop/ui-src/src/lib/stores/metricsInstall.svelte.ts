import { commands } from "../bindings";
import type { MetricsAddon, MetricsAddonId } from "../bindings";

/**
 * One-click metrics (#225): which add-on's install dialog is open, and a
 * counter bumped after each install so the views that offered it (the
 * overview, Settings) look again.
 */
export const metricsInstall = $state<{ addon: MetricsAddonId | null; installed: number }>({
  addon: null,
  installed: 0,
});

let addons: Promise<MetricsAddon[]> | null = null;

/** The add-ons (a fixed list in the backend), fetched once. */
export function loadAddons(): Promise<MetricsAddon[]> {
  addons ??= commands.cmdMetricsAddons().catch((e) => {
    addons = null;
    throw e;
  });
  return addons;
}

export function openMetricsInstall(addon: MetricsAddonId) {
  metricsInstall.addon = addon;
}

export function closeMetricsInstall() {
  metricsInstall.addon = null;
}

export function markInstalled() {
  metricsInstall.installed += 1;
}
