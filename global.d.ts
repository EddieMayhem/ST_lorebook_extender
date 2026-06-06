export {};

// Pick whichever import path your install uses.
// For "third-party" installs: ../../../../public/global
// For server-scoped installs:  ../../../../global
// Both lines are kept for editor convenience; remove the one that doesn't exist.
import '../../../../public/global';
// import '../../../../global';

declare global {
    const SillyTavern: any;
    const toastr: any;
    const $: any;
}
