import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// Implemented in ios/App/App/RemoteKeyboard.swift.
export interface RemoteKeyboardPlugin {
  show(options: { secure: boolean }): Promise<void>;
  hide(): Promise<void>;
  addListener(
    event: "input",
    listener: (event: { value: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "key",
    listener: (event: { key: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "closed", listener: () => void): Promise<PluginListenerHandle>;
}

export const RemoteKeyboard = registerPlugin<RemoteKeyboardPlugin>("RemoteKeyboard");

// Apps installed before this plugin existed lack it; they keep the web keyboard.
export const nativeKeyboard =
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("RemoteKeyboard");
