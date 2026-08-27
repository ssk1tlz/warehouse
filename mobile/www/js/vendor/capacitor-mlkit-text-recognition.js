var capacitorTextRecognition = (function (exports, core) {
    'use strict';

    /**
     * @since 8.2.0
     */
    exports.Script = void 0;
    (function (Script) {
        /**
         * The Latin script.
         *
         * @since 8.2.0
         */
        Script["Latin"] = "LATIN";
        /**
         * The Chinese script.
         *
         * @since 8.2.0
         */
        Script["Chinese"] = "CHINESE";
        /**
         * The Devanagari script.
         *
         * @since 8.2.0
         */
        Script["Devanagari"] = "DEVANAGARI";
        /**
         * The Japanese script.
         *
         * @since 8.2.0
         */
        Script["Japanese"] = "JAPANESE";
        /**
         * The Korean script.
         *
         * @since 8.2.0
         */
        Script["Korean"] = "KOREAN";
    })(exports.Script || (exports.Script = {}));

    const TextRecognition = core.registerPlugin('TextRecognition', {
        web: () => Promise.resolve().then(function () { return web; }).then(m => new m.TextRecognitionWeb()),
    });

    class TextRecognitionWeb extends core.WebPlugin {
        async processImage(_options) {
            throw this.createUnimplementedException();
        }
        createUnimplementedException() {
            return new core.CapacitorException('This method is not implemented on web.', core.ExceptionCode.Unimplemented);
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        TextRecognitionWeb: TextRecognitionWeb
    });

    exports.TextRecognition = TextRecognition;

    return exports;

})({}, capacitorExports);
//# sourceMappingURL=plugin.js.map
