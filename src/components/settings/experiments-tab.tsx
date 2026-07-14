import { DropletsIcon, WavesIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";
import { isWindowsWebview } from "@/lib/platform";

export function ExperimentsTab() {
  const dynamicAlbumMesh = useSettingsStore((s) => s.dynamicAlbumMesh);
  const setDynamicAlbumMesh = useSettingsStore((s) => s.setDynamicAlbumMesh);
  const liquidGlassRefraction = useSettingsStore(
    (s) => s.liquidGlassRefraction,
  );
  const setLiquidGlassRefraction = useSettingsStore(
    (s) => s.setLiquidGlassRefraction,
  );

  return (
    <TabPane tightTop>
      <Group>
        <SettingRow
          icon={WavesIcon}
          title="Dynamic album mesh"
          description="Animate a fluid color mesh sampled from the current album art. Turn it off to restore the original blurred-cover background."
          control={
            <Switch
              checked={dynamicAlbumMesh}
              onCheckedChange={setDynamicAlbumMesh}
              aria-label="Dynamic album mesh"
            />
          }
        />
        {/* Chromium-only: WebKit can't run SVG filters inside
            backdrop-filter, so the row is hidden on macOS/Linux where the
            classic blur material always applies. */}
        {isWindowsWebview() && (
          <SettingRow
            icon={DropletsIcon}
            title="Liquid glass refraction"
            description="Bend the content behind menus and the player through a real lens filter, like Apple's Liquid Glass. Turn it off to keep the classic blur."
            control={
              <Switch
                checked={liquidGlassRefraction}
                onCheckedChange={setLiquidGlassRefraction}
                aria-label="Liquid glass refraction"
              />
            }
          />
        )}
      </Group>
    </TabPane>
  );
}
