import { SHIM_ENTRY } from './paths';

export { armFault } from './fault-state';
export { decideShimAction } from './decide';

export function shimEntryPath(): string {
  return SHIM_ENTRY;
}
