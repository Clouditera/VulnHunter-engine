import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Keep Pi's existing global/project settings merge, but session model changes must not
 * write defaults into shared engine files. This is the SDK's storage port, not a settings parser. */
export function sessionSettings(cwd: string, engineDir: string): SettingsManager {
  const source = SettingsManager.create(cwd, engineDir);
  const values = {
    global: JSON.stringify(source.getGlobalSettings()),
    project: JSON.stringify(source.getProjectSettings()),
  };
  return SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(values[scope]);
      if (next !== undefined) values[scope] = next;
    },
  }, { projectTrusted: source.isProjectTrusted() });
}
