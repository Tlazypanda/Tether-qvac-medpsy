// Entry point. Polyfills FIRST — before any import that reaches @qvac/sdk, ethers or the worklet
// bridge, all of which touch globals JSC does not ship. Import order here is load-bearing.
import './polyfills';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
