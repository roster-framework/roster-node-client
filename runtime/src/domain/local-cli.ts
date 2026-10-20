export type LocalCliID = 'codex' | 'claude';
export type CliLaunch = { command: string; prefix: string[] };
export type LocalCliStatus = {
  id: LocalCliID; template_id: string;
  state: 'ready' | 'login_required' | 'not_found' | 'unavailable';
  installed: boolean; authenticated: boolean | null; checked_at: string;
  next_action: 'select_template' | 'login_on_runtime_host' | 'install_on_runtime_host' | 'check_runtime_host';
};
export interface LocalCliDiscovery {
  inspect(): Promise<readonly LocalCliStatus[]>;
  launch(id: LocalCliID): CliLaunch;
}
