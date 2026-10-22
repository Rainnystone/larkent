import { defineDescriptor } from '../definition';
import { DevinAdapter } from './adapter';
import { devinMetadata } from './metadata';
import { listDevinResumeHistory } from './history';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';
import { devinStderrSignatures } from './stderr-signatures';

export const devinDescriptor = defineDescriptor({
  ...devinMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: listDevinResumeHistory,
  detectionOrder: 6,
  stderrSignatures: devinStderrSignatures,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: (command) => command
    ? resolveExecutablePath(command)
    : resolveFirstAvailableBinary(devinMetadata.binaryNames),
  create: ({ profile, larkChannel }) => new DevinAdapter({
    binary: profile.agent.binaryPath ?? devinMetadata.binaryNames[0],
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
