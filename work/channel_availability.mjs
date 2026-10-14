// Retired adapters/data are retained for audit; retirement stops new requests.
export const retiredCollectionChannels=new Set(['yupao','boss']);
export const collectionChannelAvailable=key=>!retiredCollectionChannels.has(key);
