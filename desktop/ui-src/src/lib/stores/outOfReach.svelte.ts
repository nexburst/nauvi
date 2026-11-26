/**
 * How many "out of reach" empty states are on screen (OutOfReach.svelte).
 * While one shows its Retry now, the banner offers no second Retry (#526).
 */
export const outOfReach = $state({ shown: 0 });
