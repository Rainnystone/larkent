import { defineDescriptor } from '../definition';
import { KimiAdapter } from './adapter';
import { kimiMetadata } from './metadata';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';
import { kimiStderrSignatures } from './stderr-signatures';

export const kimiDescriptor = defineDescriptor({
  ...kimiMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: async () => [],
  detectionOrder: 3,
  stderrSignatures: kimiStderrSignatures,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: (command) => command
    ? resolveExecutablePath(command)
    : resolveFirstAvailableBinary(kimiMetadata.binaryNames),
  create: ({ profile, larkChannel }) => new KimiAdapter({
    binary: profile.agent.binaryPath ?? kimiMetadata.binaryNames[0],
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
