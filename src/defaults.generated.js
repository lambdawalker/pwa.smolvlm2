// Generated from config/categorization-defaults.yaml. Do not edit.
export const defaults = {
  "interface": {
    "language": "en",
    "model": "gemma-cloud",
    "view": "grid",
    "leftHanded": false,
    "cloudConsent": true,
    "showImageDetails": false,
    "showTroubleshooting": false,
    "prompt": "Classify this image into exactly one category: Indoors, Outdoors, Documents, Computer screens. If the main subject is a computer monitor or a screenshot of a computer interface, choose Computer screens. If the main subject is a page, receipt, form, or printed document, choose Documents. Otherwise choose Indoors for an interior scene or Outdoors for an exterior scene. Return only JSON: {\"category\":\"one of these categories\",\"description\":\"one sentence, as short as possible, at most 180 characters\"}."
  },
  "document": {
    "type": "pptx",
    "orientation": "portrait",
    "rows": 7,
    "columns": 2,
    "layout": "table",
    "addDescription": false
  }
};
