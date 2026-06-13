"use strict";
/**
 * CLI barrel — re-exports the public surface of the register-webhooks CLI.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:196
 * @see references/viva-docs/md/webhooks-for-payments.txt:134
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computePlan = exports.run = void 0;
var register_webhooks_js_1 = require("./register-webhooks.js");
Object.defineProperty(exports, "run", { enumerable: true, get: function () { return register_webhooks_js_1.run; } });
var plan_js_1 = require("./plan.js");
Object.defineProperty(exports, "computePlan", { enumerable: true, get: function () { return plan_js_1.computePlan; } });
//# sourceMappingURL=index.js.map