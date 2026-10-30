/**
 * Windows' language font packages ("Language.Fonts.<Script>" features on demand). A Windows in a
 * language with its own script has that package; Prism kernels (patch 007, prism7) show a window
 * the base Windows 11 fonts plus the package of its interface language and hide the rest. The
 * fonts must be on this computer for the window to show them, so the launcher downloads the
 * packages from Microsoft and installs their fonts for the current user (no administrator needed;
 * Chrome sees per-user fonts like system ones).
 *
 * The packages come from Microsoft's public Languages and Optional Features ISO 26100.1 (the one
 * patch 007's font names were taken from). The ISO is 6.8 GB, so each package is read by an HTTP
 * range: `offset` and `size` are where its .cab lies in the ISO, `fonts` the font files it has.
 */
export const LANGUAGES_AND_OPTIONAL_FEATURES_ISO =
  'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1.240331-1435.ge_release_amd64fre_SERVER_LOF_PACKAGES_OEM.iso'

export interface WindowsFontPack {
  script: string
  offset: number
  size: number
  sha256: string
  fonts: string[]
}

const pack = (script: string, offset: number, size: number, sha256: string, fonts: string): WindowsFontPack => ({
  script, offset, size, sha256, fonts: fonts.split(' ')
})

/** Every package patch 007 can show (all but PanEuropeanSupplementalFonts, which no language adds). */
export const WINDOWS_FONT_PACKS: readonly WindowsFontPack[] = [
  pack('Arab', 1314646016, 1739079, '204c65e91f4b84c0afa490ae48f89f1a1be33c199358fdd3384f2b9d999591ff', 'aldhabi.ttf andlso.ttf arabtype.ttf majalla.ttf majallab.ttf msuighub.ttf msuighur.ttf simpbdo.ttf simpfxo.ttf simpo.ttf tradbdo.ttf trado.ttf urdtype.ttf urdtypeb.ttf'),
  pack('Beng', 1316386816, 496827, '1a22dd3e5b04a31e42fd894375943bd8787ad1fb63355b09cce7fbf5d70ecf32', 'shonar.ttf shonarb.ttf vrinda.ttf vrindab.ttf'),
  pack('Cans', 1316884480, 103357, 'de04f5dcdf8ca9c6611fb9a47c9d56d59838f502d08fcdf87b4f1c4fb0c3482f', 'euphemia.ttf'),
  pack('Cher', 1316988928, 132881, '3771f3d7326367dbd08fdb2f21727e52181404431a971329e8b133d200e61e75', 'plantc.ttf'),
  pack('Deva', 1317122048, 1566924, 'a47d83e973826bacfb504626d9fccd146ee2dd423edde6d173a7889516b57886', 'aparaj.ttf aparajb.ttf aparajbi.ttf aparaji.ttf kokila.ttf kokilab.ttf kokilabi.ttf kokilai.ttf mangal.ttf mangalb.ttf sanskr.ttf utsaah.ttf utsaahb.ttf utsaahbi.ttf utsaahi.ttf'),
  pack('Ethi', 1318690816, 340372, '15d0b09ecad7a629122089007d708f942a54a684c5f23c2f3ff10c712eba89e0', 'nyala.ttf'),
  pack('Gujr', 1319032832, 219740, '638743bd467e849e1c3f1ac2f8c24e8ddb6f4f807d9d0e4a9b66c33e29d31b52', 'shruti.ttf shrutib.ttf'),
  pack('Guru', 1319254016, 120507, '88a5d7141573d41bd815b016a2973380e57eec3df6109f1ce62db90141102b95', 'raavi.ttf raavib.ttf'),
  pack('Hans', 1319374848, 43883622, '10389507eb82a9e022186b624e4d9a0a6564920c7f65e49971da557e085499f2', 'deng.ttf dengb.ttf dengl.ttf simfang.ttf simhei.ttf simkai.ttf'),
  pack('Hant', 1363259392, 13530376, '2a91409e37e8a09992d39a2f11f513dbfa8a2ce4a49c5c310f96843886c62f89', 'kaiu.ttf mingliu.ttc'),
  pack('Hebr', 1376790528, 388818, '9557aed066031474d8db1c11fdfa11c7132f9a363a413b752fb8a43cfabaa013', 'ahronbd.ttf david.ttf davidbd.ttf frank.ttf gisha.ttf gishabd.ttf lvnm.ttf lvnmbd.ttf mriam.ttf mriamc.ttf nrkis.ttf rod.ttf'),
  pack('Jpan', 1377179648, 53180839, '5b676aedbdf50277ab092a59c47ed97ba2da085cf2fe679da625bf18c0a3103c', 'biz-udgothicb.ttc biz-udgothicr.ttc biz-udminchom.ttc meiryo.ttc meiryob.ttc msgothic.ttc msmincho.ttc uddigikyokashon-b.ttc uddigikyokashon-r.ttc yumin.ttf yumindb.ttf yuminl.ttf'),
  pack('Khmr', 1430362112, 425046, 'a1b8417d5448dba9b6a67c1f2caf0d695890fce7bc19a6e2589c8df4c794fcdd', 'daunpenh.ttf khmerui.ttf khmeruib.ttf moolbor.ttf'),
  pack('Knda', 1430788096, 213301, 'fee5f14e8cff5bc2c2ed8ec9338a3bb703ea644561285db56260be076f40556a', 'tunga.ttf tungab.ttf'),
  pack('Kore', 1431003136, 9748860, 'd6cf56321dde503390a3f448b090b6dec70f6a9270573b51b376c092a3314f34', 'batang.ttc gulim.ttc'),
  pack('Laoo', 1440753664, 197349, '7f73c6a145c41c571186aa31f701126c28cf0706f8b313f34b4439e2c57942de', 'dokchamp.ttf laoui.ttf laouib.ttf'),
  pack('Mlym', 1440952320, 172499, '24ffb13ed6d3a1c60d9ca50367559909398b378be2d4cea9dd0fac9fcee16ca9', 'kartika.ttf kartikab.ttf'),
  pack('Orya', 1441126400, 257869, '1a2bab7afefeab26261657ccc9e720e0ad1a235a5e704ffa5063f476060327f8', 'kalinga.ttf kalingab.ttf'),
  pack('Sinh', 1446017024, 430008, '00c4bf98d92488bc697dbb6f0f7abe7a676c64338c63bc7e7c7ae6ba92efced8', 'iskpota.ttf iskpotab.ttf'),
  pack('Syrc', 1446447104, 79828, '4c8ae3df917213c49c9c7a85c57cd8914732d627ccc61ed6469150b3572e6e7b', 'estre.ttf'),
  pack('Taml', 1446526976, 303988, '6cb9e61d5047832c44f1bcee32b6a1074ebac994c124bc75814862c437fefc9f', 'latha.ttf lathab.ttf vijaya.ttf vijayab.ttf'),
  pack('Telu', 1446832128, 516308, '647d7d990bff8735b07c5eb764a866c03445f704af52c81f9b54eb56539d9751', 'gautami.ttf gautamib.ttf vani.ttf vanib.ttf'),
  pack('Thai', 1447350272, 1697133, '950bac74d76cbfe28687d125a3a5479ff0d08404b569ba120872a9aaff14f822', 'angsana.ttc browalia.ttc cordia.ttc leelawad.ttf leelawdb.ttf upcdb.ttf upcdbi.ttf upcdi.ttf upcdl.ttf upceb.ttf upcebi.ttf upcei.ttf upcel.ttf upcfb.ttf upcfbi.ttf upcfi.ttf upcfl.ttf upcib.ttf upcibi.ttf upcii.ttf upcil.ttf upcjb.ttf upcjbi.ttf upcji.ttf upcjl.ttf upckb.ttf upckbi.ttf upcki.ttf upckl.ttf upclb.ttf upclbi.ttf upcli.ttf upcll.ttf')
]

export const windowsFontPack = (script: string) => WINDOWS_FONT_PACKS.find((item) => item.script === script)

/**
 * The script whose package Windows adds for a display language (the kernel's own mapping,
 * WindowsFontScriptFor in patch 007), or undefined when the base fonts cover it.
 */
export function windowsFontScript(language: string): string | undefined {
  const lang = language.trim().toLowerCase().replace(/_/g, '-')
  const primary = lang.split('-')[0]
  if (primary === 'zh') return /-(tw|hk|mo)\b|hant/.test(lang) ? 'Hant' : 'Hans'
  const scripts: Record<string, string> = {
    ja: 'Jpan', ko: 'Kore', th: 'Thai', ar: 'Arab', fa: 'Arab', ur: 'Arab', ps: 'Arab', ug: 'Arab', sd: 'Arab',
    he: 'Hebr', iw: 'Hebr', yi: 'Hebr', hi: 'Deva', mr: 'Deva', ne: 'Deva', kok: 'Deva', sa: 'Deva',
    bn: 'Beng', as: 'Beng', gu: 'Gujr', pa: 'Guru', kn: 'Knda', ml: 'Mlym', or: 'Orya', ta: 'Taml',
    te: 'Telu', si: 'Sinh', km: 'Khmr', lo: 'Laoo', am: 'Ethi', ti: 'Ethi', syr: 'Syrc', chr: 'Cher', iu: 'Cans'
  }
  return scripts[primary]
}

/** A language that uses each script, to name the package in the UI's own language. */
const SCRIPT_LANGUAGE: Record<string, string> = {
  Hans: 'zh-Hans', Hant: 'zh-Hant', Jpan: 'ja', Kore: 'ko', Thai: 'th', Arab: 'ar', Hebr: 'he',
  Deva: 'hi', Beng: 'bn', Gujr: 'gu', Guru: 'pa', Knda: 'kn', Mlym: 'ml', Orya: 'or', Taml: 'ta',
  Telu: 'te', Sinh: 'si', Khmr: 'km', Laoo: 'lo', Ethi: 'am', Syrc: 'syr', Cher: 'chr', Cans: 'iu'
}

export function fontPackLabel(script: string, uiLocale: string): string {
  const language = SCRIPT_LANGUAGE[script]
  if (!language) return script
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(language) ?? script
  } catch {
    return script
  }
}

export interface FontPackProgress {
  script: string
  receivedBytes: number
  totalBytes: number
  stage: 'downloading' | 'installing' | 'done'
}

export interface FontPackStatus {
  /** Scripts whose package is on this computer. */
  installed: string[]
  /** Scripts of WINDOWS_FONT_PACKS still missing. */
  missing: string[]
  supported: boolean
  /** Windows 10's Segoe UI Emoji (renamed) that Windows 10 windows use on Windows 11. */
  windows10Fonts?: { installed: boolean; hostPlatformVersion: string }
}
