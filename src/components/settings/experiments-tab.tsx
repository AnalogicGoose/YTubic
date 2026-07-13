import { WavesIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";

export function ExperimentsTab() {
  const dynamicAlbumMesh = useSettingsStore((s) => s.dynamicAlbumMesh);
  const setDynamicAlbumMesh = useSettingsStore((s) => s.setDynamicAlbumMesh);

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
      </Group>
    </TabPane>
  );
}
