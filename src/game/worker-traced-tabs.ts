// Import only from the worker entry: a main-thread import would put the trace
// data in the entry chunk instead of the lazy one.
import { installTracedTabGenerator } from '../puzzle/topology/traced-tab-loader.js';
import { tracedTabGenerator } from '../puzzle/topology/traced-tab-generator.js';

installTracedTabGenerator(tracedTabGenerator);
