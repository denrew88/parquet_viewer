import { expect, type Locator } from "@playwright/test";

export type SettingsCategory = "CSV" | "SQL" | "Copy" | "Display" | "Storage";

export async function selectSettingsCategory(dialog: Locator, category: SettingsCategory) {
  const navigation = dialog.getByRole("tablist", { name: "Settings categories", exact: true });
  const tab = navigation.getByRole("tab", { name: category, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const panel = dialog.getByRole("tabpanel", { name: category, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
