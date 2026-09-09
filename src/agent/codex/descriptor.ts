import { listCodexResumeHistory } from './history';
import { defineDescriptor } from '../definition';
import { CodexAdapter } from './adapter';
import { codexMetadata } from './metadata';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';
import { codexAdapterAgentOptions } from './options';

export const codexDescriptor = defineDescriptor({
  ...codexMetadata,
  acceptsImagePaths: true,
  acceptsRawResumeHandle: false,
  listResumeHistory: listCodexResumeHistory,
  detectionOrder: 2,
  resolveProfileBinary: (profile) => profile.agent.binaryPath ?? profile.codex?.binaryPath,
  detectBinary: (command) => command
    ? resolveExecutablePath(command)
    : resolveFirstAvailableBinary(codexMetadata.binaryNames),
  create: ({ profile, profileDir, larkChannel }) => {
    const binary = profile.agent.binaryPath ?? profile.codex?.binaryPath;
    if (!binary) throw new Error('codex profile requires codex.binaryPath');
    return new CodexAdapter({
      binary,
      profileStateDir: profileDir,
      agentOptions: codexAdapterAgentOptions(profile),
      sandbox: profile.sandbox.defaultMode,
      larkChannel,
    });
  },
});
