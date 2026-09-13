import { EventEmitter } from 'events';
import { ScoutAction, ScoutCapabilities, ScoutConnection } from './types';

/** Events: action, request, auth-required, disconnected, limitation. Captures are sanitized by the session before storage. */
export abstract class BrowserAdapter extends EventEmitter {
    abstract readonly capabilities: ScoutCapabilities;
    abstract connect(connection: ScoutConnection): Promise<void>;
    abstract setCapture(enabled: boolean): Promise<void>;
    abstract currentUrl(): Promise<string>;
    abstract navigate(url: string): Promise<void>;
    abstract perform(action: ScoutAction): Promise<void>;
    abstract settle(): Promise<void>;
    abstract disconnect(): Promise<void>;
}
