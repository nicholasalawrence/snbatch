import { homedir } from 'os';
import { join } from 'path';

export const HOME_DIR = homedir();
export const SNBATCH_DIR = join(HOME_DIR, '.snbatch');
export const PROFILES_PATH = join(SNBATCH_DIR, 'profiles.json');
export const HISTORY_PATH = join(SNBATCH_DIR, 'history.json');
export const LOGS_DIR = join(SNBATCH_DIR, 'logs');
export const CONFIG_PATH = join(SNBATCH_DIR, 'config.json');
