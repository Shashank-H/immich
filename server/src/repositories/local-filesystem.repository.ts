import { Injectable } from '@nestjs/common';
import chokidar, { ChokidarOptions } from 'chokidar';
import { existsSync, readFileSync, watch } from 'node:fs';
import fs from 'node:fs/promises';

export interface WatchEvents {
  onReady(): void;
  onAdd(path: string): void;
  onChange(path: string): void;
  onUnlink(path: string): void;
  onError(error: Error): void;
}

export interface DiskUsage {
  available: number;
  free: number;
  total: number;
}

export interface LocalDirectoryEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
}

/** Operations tied to the host on which the Immich server is running. */
@Injectable()
export class LocalFilesystemRepository {
  async listDirectory(folder: string): Promise<LocalDirectoryEntry[]> {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    }));
  }

  readFileSync(filepath: string): Buffer {
    return readFileSync(filepath);
  }

  readFile(filepath: string): Promise<Buffer> {
    return fs.readFile(filepath);
  }

  exists(filepath: string): boolean {
    return existsSync(filepath);
  }

  async canAccess(filepath: string): Promise<boolean> {
    try {
      await fs.access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  async getVideoDevices(): Promise<string[]> {
    try {
      return await fs.readdir('/dev/dri');
    } catch {
      return [];
    }
  }

  async hasMaliOpenCL(): Promise<boolean> {
    try {
      const [icd, device] = await Promise.all([fs.stat('/etc/OpenCL/vendors/mali.icd'), fs.stat('/dev/mali0')]);
      return icd.isFile() && device.isCharacterDevice();
    } catch {
      return false;
    }
  }

  async getDiskUsage(folder: string): Promise<DiskUsage> {
    const stats = await fs.statfs(folder);
    return {
      available: stats.bavail * stats.bsize,
      free: stats.bfree * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
  }

  watch(paths: string[], options: ChokidarOptions, events: Partial<WatchEvents>) {
    const watcher = chokidar.watch(paths, options);
    watcher.on('ready', () => events.onReady?.());
    watcher.on('add', (path) => events.onAdd?.(path));
    watcher.on('change', (path) => events.onChange?.(path));
    watcher.on('unlink', (path) => events.onUnlink?.(path));
    watcher.on('error', (error) => events.onError?.(error as Error));
    return () => watcher.close();
  }

  watchDirectory = watch;
}
