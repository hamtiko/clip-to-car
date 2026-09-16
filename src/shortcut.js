// Generates an installable iOS Shortcut (.shortcut plist) for the address flow.
//
// The Worker knows its own origin, so the URL is baked in and the ONLY thing
// the installer is asked for is the TOKEN — via WFWorkflowImportQuestions,
// which Shortcuts prompts for at import time.
//
// The token is held in a Text action and referenced from the Authorization
// header, so it is never in the URL (§5) and never in this file.
//
// Shape of the generated shortcut:
//   [0] Text          -> the TOKEN (the import question fills this in)
//   [1] Get Contents  -> POST <base>/set, Authorization: Bearer <0>,
//                        body = the shared text (or clipboard)
// Share Sheet input is a workflow property, not an action:
//   WFWorkflowInputContentItemClasses limits it to text and URLs, and
//   WFWorkflowNoInputBehavior falls back to the clipboard when run directly.

const TOKEN_UUID = "8E7D6C5B-4A39-4821-9F0E-1D2C3B4A5968";

// U+FFFC OBJECT REPLACEMENT CHARACTER marks where a variable is spliced into a
// string; attachmentsByRange then says what goes at that index.
const OBJ = "￼";

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A WFTextTokenString with no variables in it.
function plainText(s) {
  return `<dict>
        <key>Value</key>
        <dict><key>string</key><string>${xmlEscape(s)}</string></dict>
        <key>WFSerializationType</key><string>WFTextTokenString</string>
      </dict>`;
}

export function buildShortcutPlist(baseUrl) {
  const setUrl = baseUrl.replace(/\/+$/, "") + "/set";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowClientVersion</key><string>2605.0.5</string>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>463140863</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>59481</integer>
  </dict>
  <key>WFWorkflowTypes</key>
  <array><string>ActionExtension</string></array>
  <key>WFQuickActionSurfaces</key><array/>
  <key>WFWorkflowHasShortcutInputVariables</key><true/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array>
    <string>WFStringContentItem</string>
    <string>WFURLContentItem</string>
  </array>
  <key>WFWorkflowNoInputBehavior</key>
  <dict>
    <key>Name</key><string>WFWorkflowNoInputBehaviorGetClipboard</string>
    <key>Parameters</key><dict/>
  </dict>

  <key>WFWorkflowImportQuestions</key>
  <array>
    <dict>
      <key>ActionIndex</key><integer>0</integer>
      <key>Category</key><string>Parameter</string>
      <key>DefaultValue</key><string></string>
      <key>ParameterKey</key><string>WFTextActionText</string>
      <key>Text</key><string>Paste your clip-to-car TOKEN</string>
    </dict>
  </array>

  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key><string>${TOKEN_UUID}</string>
        <key>CustomOutputName</key><string>Token</string>
        <key>WFTextActionText</key>
        ${plainText("")}
      </dict>
    </dict>

    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFURL</key>${plainText(setUrl)}
        <key>WFHTTPMethod</key><string>POST</string>
        <key>WFHTTPBodyType</key><string>File</string>
        <key>WFRequestVariable</key>
        <dict>
          <key>Value</key><dict><key>Type</key><string>ExtensionInput</string></dict>
          <key>WFSerializationType</key><string>WFTextTokenAttachment</string>
        </dict>
        <key>WFHTTPHeaders</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>WFDictionaryFieldValueItems</key>
            <array>
              <dict>
                <key>WFItemType</key><integer>0</integer>
                <key>WFKey</key>${plainText("Authorization")}
                <key>WFValue</key>
                <dict>
                  <key>Value</key>
                  <dict>
                    <key>string</key><string>Bearer ${OBJ}</string>
                    <key>attachmentsByRange</key>
                    <dict>
                      <key>{7, 1}</key>
                      <dict>
                        <key>Type</key><string>ActionOutput</string>
                        <key>OutputUUID</key><string>${TOKEN_UUID}</string>
                        <key>OutputName</key><string>Token</string>
                      </dict>
                    </dict>
                  </dict>
                  <key>WFSerializationType</key><string>WFTextTokenString</string>
                </dict>
              </dict>
              <dict>
                <key>WFItemType</key><integer>0</integer>
                <key>WFKey</key>${plainText("Content-Type")}
                <key>WFValue</key>${plainText("text/plain; charset=utf-8")}
              </dict>
            </array>
          </dict>
          <key>WFSerializationType</key><string>WFDictionaryFieldValue</string>
        </dict>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}
