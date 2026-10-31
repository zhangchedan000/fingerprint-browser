import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { OtherWindows } from '../shared/hardware-profiles'
import type { AppLogger } from './app-logger'
import { fontRegistryName } from './language-fonts'

const execFileAsync = promisify(execFile)

/**
 * Fonts of the other Windows, shipped in the kernel package (`prism-fonts` next to chrome.exe; the
 * originals are in the private prism-kernel repo, private-assets/). A Windows 10 window on a
 * Windows 11 computer gets every Windows 10 font file that differs from Windows 11's (Arial, Segoe UI,
 * Malgun Gothic, Yu Gothic, emoji …); a Windows 11 window on a Windows 10 computer gets Windows 11's.
 * They are installed renamed ("PrismW10 …" / "PrismW11 …"; prism15+ kernels ask for the window's
 * Windows' copy of every family first, patch 007), except Segoe Fluent Icons, Segoe UI Variable,
 * Sans Serif Collection and Cascadia, which Windows 10 does not have and keep their names (their
 * names are only shown to Windows 11 windows, Sans Serif Collection to all). A Windows 10
 * window on a Windows 10 computer gets Sans Serif Collection from the Windows 11 fonts ("win10host",
 * windows10HostFonts in hardware-profiles.ts).
 */
export const PRISM_FONTS_FOLDER = 'prism-fonts'

/** A set of fonts from the kernel package: the other Windows' or, on Windows 10, Windows 10's extras. */
export type PrismFontSet = OtherWindows | 'win10host'

interface FontFile { file: string; sha256: string; renamed: boolean }
const SANS_SERIF_COLLECTION: FontFile = { file: 'SansSerifCollection.ttf', sha256: 'eb78c210d380fce7d3822b3a5ccfa808f1eb0390de6237f5460970679f393ce0', renamed: false }
/** folder: the kernel package's folder under prism-fonts (the set's name when not given). */
const FONT_SETS: Record<PrismFontSet, { prefix: string; folder?: OtherWindows; files: FontFile[] }> = {
  // Every C:\Windows\Fonts file of Windows 10 LTSC 21H2 that Windows 11 25H2 has in another version or
  // not at all (prism15; prism13-14 kernels ship only seguiemj.ttf and use only it).
  win10: { prefix: 'PrismW10', files: [
    { file: 'arial.ttf', sha256: 'c9b76220a5be42ead4733611e417cd65c5fd8aeaa33eb56576ac378a37d130a1', renamed: true },
    { file: 'arialbd.ttf', sha256: '766f06ac8761f82f25d032a220e89438f6064591af9915061f20b949efdedf69', renamed: true },
    { file: 'arialbi.ttf', sha256: 'e432c1b3568bd207e30e3d52d41e6431ea53a679eb52dd79b1a36aa6a4f3b994', renamed: true },
    { file: 'ariali.ttf', sha256: '79a5742b865cf06891d4ae43e42cac0e5169c7b7b06b5b3c24ef8e0966d27b62', renamed: true },
    { file: 'bahnschrift.ttf', sha256: 'bff1ca87ea35e376691498c618556411f0ee71784b32aa351e6e8f9e8bd609dd', renamed: true },
    { file: 'calibri.ttf', sha256: '198e8dac512206f27c9bdbfeb3d5b3e55a33de9dcf58d801823ef8c5ef5a76dc', renamed: true },
    { file: 'calibrib.ttf', sha256: '4d5c56c07c41315022cd5a24966ade3983ceebce8bc81524e56e4632dd3f242f', renamed: true },
    { file: 'calibrii.ttf', sha256: '5c85b9adedde710e754b3163005291eca16cd0ccccc7c8d7ff526070e8980202', renamed: true },
    { file: 'calibril.ttf', sha256: '67374b8f4735eabfc7f173f28dc1789d7dbd4e2919532d173f6d697211cc3263', renamed: true },
    { file: 'calibrili.ttf', sha256: 'a49f79197a091a82c45779b3cca7bc2cc7b471cf1447b55378c565c4f06844a5', renamed: true },
    { file: 'calibriz.ttf', sha256: '95b49ebc8244b88ef49372833e8964dad6a3d7fa53e948609c5c73d5a1439912', renamed: true },
    { file: 'Candara.ttf', sha256: '9f02f6bf076197ed2a1335fe59a3bdf88e7ad4a849bf68037a528f37cce36791', renamed: true },
    { file: 'Candarab.ttf', sha256: '5346840fa85a1969699dc97635e838cd2c42dad7f8a4999d7368eb888fceb04b', renamed: true },
    { file: 'Candarai.ttf', sha256: 'fc68cb42582e1207bcc397df7b60870a74ae068b17d7bd79f2e9f63af89796b4', renamed: true },
    { file: 'Candaral.ttf', sha256: '0e14f663fa34460fe9a07bb32d0017a180a4a0c8457d279fbfc5d8452753b477', renamed: true },
    { file: 'Candarali.ttf', sha256: 'e8b17bc645c098bbc5167acfe13f0e3c63f0f417d539aab171db7eea3c40eab2', renamed: true },
    { file: 'Candaraz.ttf', sha256: '1614c0d3a6751eb46b2c52f09ae23dd61f769beda83058269cb0653c049eae43', renamed: true },
    { file: 'comic.ttf', sha256: 'a7da3ef195158acd8432226a21f2940f1806a9c8d079f18d0a9ab475f50f9659', renamed: true },
    { file: 'comicbd.ttf', sha256: '56567bc71e89fd173674c78f02b474123a02561b246526a22600c3a29b2fdc65', renamed: true },
    { file: 'comici.ttf', sha256: '65aece2928246837317e093a11c6df5cbfc67035f1e045c9771f7c408be1faea', renamed: true },
    { file: 'comicz.ttf', sha256: 'c691699eaf218e702b2d77c1f62d2c080be6248f1c11018b0b2556834a9cecb1', renamed: true },
    { file: 'consola.ttf', sha256: 'c6e6ce8119fdd47ec6a5449a08e2d2ad7f41ea03143aae193068ed9fa58eaebc', renamed: true },
    { file: 'consolab.ttf', sha256: '8fa803e5abc7fff0c78c62cd22d07c705f3273c53312380c36ff484246ed3c1b', renamed: true },
    { file: 'consolai.ttf', sha256: '81e2a95d3c49468029c07e58f71a5f0ca4cfcb617eaf6bd77576fb03aa430bb2', renamed: true },
    { file: 'consolaz.ttf', sha256: '1df27cbcc8a9fb7f843bc24e257b78e8ff93de70e8c1ad2caab8379e7d6a1eab', renamed: true },
    { file: 'cour.ttf', sha256: '93c3ff526c19d03496c01c6a1bfd1031f97af021a13e859a89dfc717a0b6b6ec', renamed: true },
    { file: 'courbd.ttf', sha256: '716c08d704f154870bd9fb78b185d0b644912301dfa9c9e6daf45bdb4832a299', renamed: true },
    { file: 'courbi.ttf', sha256: '8fdb188252a2db0f020c89831bddb61cadfe290c3616fe534479b4d3b10d09c1', renamed: true },
    { file: 'couri.ttf', sha256: '5861588608d3a3775d921a7e4acb8362b21630c6b63718bc68adb7137ce53beb', renamed: true },
    { file: 'ebrima.ttf', sha256: 'a97f0f43503d9f6ef87c1534eedc753084fa6154ca3fd0b6e51156621e28584a', renamed: true },
    { file: 'ebrimabd.ttf', sha256: '1e016947ceedd2b46dd098b5a033526ef4f0c0e7d58968a2203ab69443949350', renamed: true },
    { file: 'gadugi.ttf', sha256: 'ef2c245c5b895e4cb4fd67b1842141921ff17e5812d8daca7f1f7f760e848552', renamed: true },
    { file: 'gadugib.ttf', sha256: '21b256efb2eaaf7bbbf99865bcda5a3e04bb78d9740929d0d6e37d4cc50ae7b0', renamed: true },
    { file: 'Inkfree.ttf', sha256: '8b89481f274ee1ad6fe49f539fc4435e114bc684beecb3fdafd6c7817bd05d85', renamed: true },
    { file: 'LeelaUIb.ttf', sha256: '16d0c83e99ca3cd56a85966c4ff2c5f0c0f8a5a7140a7594b2ec3e404c8e96a0', renamed: true },
    { file: 'LeelawUI.ttf', sha256: '796dc7e97b357f9c2ad10044d01a86d3fb49cf80e3693011eb055c466c995de0', renamed: true },
    { file: 'LeelUIsl.ttf', sha256: '2e2fabd71aa30f0d7039b879ee58441a791e095a6656064eb9d4a84a071e5e8f', renamed: true },
    { file: 'malgun.ttf', sha256: '0086c19e81d293a542e7d75564c645fb58070cc850aefebf8fa1c397858e510c', renamed: true },
    { file: 'malgunbd.ttf', sha256: 'a541834fb9cdde9bd6d2c3ff1565cb0bb5ccf7a15e4e9daf2cb58d9b1cf282aa', renamed: true },
    { file: 'malgunsl.ttf', sha256: 'a7217a2e590c86141bddadc74a2bcdff2efe210db48469a77a749e0446d91ea9', renamed: true },
    { file: 'micross.ttf', sha256: '3f557479a768a1d9924af0f29d0d842e8c41988738ce891f6be3abb0f008b0d5', renamed: true },
    { file: 'mingliub.ttc', sha256: '814fc6cc5407d2137022a1ff8587cfa43d5a2736b2ab5378ea49ceb5c072de37', renamed: true },
    { file: 'mmrtext.ttf', sha256: '3ed4612d44f71851d33a126bb483b08a623feb0b2731025a73a41898dec7cee7', renamed: true },
    { file: 'mmrtextb.ttf', sha256: 'f56f3c5a1c1896f83c977f90bf7ab39729f7ea2c39f4d7484b06635c7c6fc0bd', renamed: true },
    { file: 'monbaiti.ttf', sha256: '707585b9acfc1507d9bd943bb5435f75768274b1a12b1f71de76ad78be4d7e7b', renamed: true },
    { file: 'msjh.ttc', sha256: '0b50839f0e13f9e1607b46568aa953fc1491eb3f867f2737e6a4ff9eb3696aa9', renamed: true },
    { file: 'msjhbd.ttc', sha256: '73293967f4bb2ceb68a40d642d7dbe410ea55abb1410ba94c02d9d88e4d055bf', renamed: true },
    { file: 'msjhl.ttc', sha256: 'd3b01af9bfc265ee4057b76c897243ed42f14d62a78b7306084e54dba37a548e', renamed: true },
    { file: 'mvboli.ttf', sha256: 'a5b742323c8da0fe29b0003fb0073969b757865fbf91789d32206397593c4d6a', renamed: true },
    { file: 'Nirmala.ttf', sha256: '290ab4239acf6145d080713cb79cf13be95f320d1ae47afea1f5dee4ad20ecc5', renamed: true },
    { file: 'NirmalaB.ttf', sha256: '07e0e53736a610b4c688fbac85159462d264b81359c76095639c6bce7e20d1e9', renamed: true },
    { file: 'NirmalaS.ttf', sha256: 'c4b4a8d284a24a754fd745fcbbfe300df81b2be04c82278ee5d857b29cd64e64', renamed: true },
    { file: 'segmdl2.ttf', sha256: 'e968d310e4cf8b695d293c70cf1d98ca4cacc823677c2464ff347b47907fa861', renamed: true },
    { file: 'segoesc.ttf', sha256: 'd0dfad2f6bbe7ff7c0f96a0c80a28bd4f4624f900573a61abd9d29406d3775d7', renamed: true },
    { file: 'segoescb.ttf', sha256: '91283e8af7f9eca8b14b498b484b35d49c3bd3144ab7e25aa4934297138ea28b', renamed: true },
    { file: 'segoeui.ttf', sha256: 'ba32a222b23d727267cf1aba4e5296fe84ce99b9d910915103fc085d7931bc88', renamed: true },
    { file: 'segoeuib.ttf', sha256: '1b242874a2f57529060e770ba313e027a99d40b3c36e1c7e8b2dece16ad6ed88', renamed: true },
    { file: 'segoeuii.ttf', sha256: '9adf7d619c593ee38c96af06bb15b4bd893e4087bcc1a0b7becee8f4ae15bb1c', renamed: true },
    { file: 'segoeuil.ttf', sha256: '1a2231bbd4fad4a3ac8c0b8a93af0bce58324a8b3605df16038a9e660a0c072a', renamed: true },
    { file: 'segoeuisl.ttf', sha256: '38a85c09ee4fc558e7739ebdd1a15a06e2846ebb787cf73b1b6476a3a5b22000', renamed: true },
    { file: 'segoeuiz.ttf', sha256: '45e7504e9bbd70ead482ebbddbeec04b2bea9f490b994658a95146cdf0733449', renamed: true },
    { file: 'seguibl.ttf', sha256: 'e17738f092c8b02f4443867a7dfcdde66fb4cd6f6b10de8e40b2f3192f8a5835', renamed: true },
    { file: 'seguibli.ttf', sha256: '33212faa85fad61785cd6917172378b798bc9f5d4c47c121437354f47980aa6f', renamed: true },
    { file: 'seguiemj.ttf', sha256: '7c0244dd8eeb7c6bdecdfc3f9e59833527fc18a66d0295ce47339069692a2b4f', renamed: true },
    { file: 'seguihis.ttf', sha256: '1cbe547c648ff673c30ca91c6a4f091addd1a4b605a9798f84089add47e9b884', renamed: true },
    { file: 'seguili.ttf', sha256: '7726b24daa0c1f47e528d8df78b98717bdb4425bcf37e50330945e32c6d17d7c', renamed: true },
    { file: 'seguisb.ttf', sha256: '9853283466bd43993b9813215281fb9c7090cbd8e9b5453f6d0d040622e117e2', renamed: true },
    { file: 'seguisbi.ttf', sha256: '9959977d9fcf8ebc5fe48f6ee418f05378132b47d21bd5dcc798ad7cff274006', renamed: true },
    { file: 'seguisli.ttf', sha256: '9f84a0a9193fe1d6335967f46606997a208adde053d006b21c03f9375ec5d416', renamed: true },
    { file: 'seguisym.ttf', sha256: 'd2f8326a354456d93e78b0537c58793e7072c3617af7d9ee187f10d6d595f510', renamed: true },
    { file: 'Sitka.ttc', sha256: '18f4d0f9de114e04a6f0b21955a96177154ff0f55fb4a94c68af5c51449bf107', renamed: true },
    { file: 'SitkaB.ttc', sha256: 'eac5da16a297e4292decbf8c6735d0912f342c6ba9c2844d362126b3de1136ca', renamed: true },
    { file: 'SitkaI.ttc', sha256: '1581ff0e4ecc7ec2835c02678b62ee7c8e89937e4142aff11030548ff04d40a7', renamed: true },
    { file: 'SitkaZ.ttc', sha256: '9ba07e98c2dfe00c7f00a44cc74da52a9818d39988a105c6af6974a63d04b9ad', renamed: true },
    { file: 'sylfaen.ttf', sha256: 'c7a5df780936c04804287e32c1b77e78b9b0e46b8d2723a85bda987eec8de024', renamed: true },
    { file: 'tahoma.ttf', sha256: 'b890858df485549d20fcb0a2c519dffe9c5c155d16b55e0b9252d6e66db555e5', renamed: true },
    { file: 'tahomabd.ttf', sha256: '68f92341975acc275c7d4a2ec52a1569b70e992b521c42b30f29149806421674', renamed: true },
    { file: 'times.ttf', sha256: '2cff2a03d8034801979dd6d16f09b9a825c3d710fcf068f2ebfbf0e1425c87cf', renamed: true },
    { file: 'timesbd.ttf', sha256: '621b4a765fef5d255d19530f4bf936104c6519f2e232a0eef1923474e5b9cf22', renamed: true },
    { file: 'timesbi.ttf', sha256: '2852329a38acf9252504669d9c23d5e88366cf77e8209d508f5e7198639648ea', renamed: true },
    { file: 'timesi.ttf', sha256: '3a1c2bc8528bfa432e0414d4ec69bf5813563c474e16a9ad0f57ca262f8d24a2', renamed: true },
    { file: 'YuGothB.ttc', sha256: '15157483588f2778a180f2b401256df12b582513fa0655f8172937c85521b80b', renamed: true },
    { file: 'YuGothL.ttc', sha256: '7a06352c79894d1a5d0f3199061fe43a327ded93c0ff316541ce31cf314968cc', renamed: true },
    { file: 'YuGothM.ttc', sha256: '3e7d80ef5a1615134800c1b1b3b9d9ee870085e8486b884258de2519dd62b1cb', renamed: true },
    { file: 'YuGothR.ttc', sha256: '1e5a4b342c6417bb9352e8c29cb839413987a06438e7b48fd0320925827f289c', renamed: true }
  ] },
  // Every C:\Windows\Fonts file of Windows 11 25H2 that Windows 10 LTSC 21H2 has in another version or
  // not at all, and Cascadia (private-assets/win11-fonts/SHA256-list.txt; prism13-14 kernels ship 10).
  win11: { prefix: 'PrismW11', files: [
    { file: 'arial.ttf', sha256: 'b3658eadae55e682b5f69eb64c439c1ecc8f196c0bb8d4756d145d13bc86476a', renamed: true },
    { file: 'arialbd.ttf', sha256: 'e8f4e3baf6cc35fed6fcce3a540e8b39e8f6cda1d22a28f2ec8f526fef7a43f5', renamed: true },
    { file: 'arialbi.ttf', sha256: '267a411525980d648f10a7222a6ff1ebe4d4feeefbf9b3100cae2b5cfab5594a', renamed: true },
    { file: 'ariali.ttf', sha256: '86b32db9a06f9694e2a3760c42e5117bcdc5cc1255bb5186ca8ce0305e22f288', renamed: true },
    { file: 'bahnschrift.ttf', sha256: 'eaad201da94cb323401fdb8cc760650803ddf8fd704cb9fa56317e6c69bc6fd6', renamed: true },
    { file: 'calibri.ttf', sha256: '57e93ff143572bcc092c1f56202d43ddc07bb119aa104c6d7af163470fb551f6', renamed: true },
    { file: 'calibrib.ttf', sha256: '0a8296747536ead27d5f48f67e911cc3b207742b3f704e66995251d12fd422e5', renamed: true },
    { file: 'calibrii.ttf', sha256: '7f150e9eabe5db3e1b0f9469dca5c96176bc2fbb306dc9d48b7029dc69c52763', renamed: true },
    { file: 'calibril.ttf', sha256: '2db491080305b349588b9851fb6fe960eee04cd7c1097784a987287d782f0a54', renamed: true },
    { file: 'calibrili.ttf', sha256: '64ca9b15ca79927c3c4c69094bb41f78e5f0d79e9501d9d381a8794b220eead1', renamed: true },
    { file: 'calibriz.ttf', sha256: '760539bfedbe24e7853ca8a621d9cb1f3de52036c116e81aae36b33c4ab60a7c', renamed: true },
    { file: 'Candara.ttf', sha256: '002c1e3378d02ed7dbdb3df1c94d433413a56f3f2f3aa8315a57720ee851dc45', renamed: true },
    { file: 'Candarab.ttf', sha256: 'ec0dce5170aaaf2cf485d4ba39d86fbba1dd1c76d9140cbf75a6b84b50fb20de', renamed: true },
    { file: 'Candarai.ttf', sha256: 'c165dbbc35bbf1fefae865c3e6b02404c8d182074fe04e78e221bab7d35ce3f8', renamed: true },
    { file: 'Candaral.ttf', sha256: 'c35742957794a81b6c73aa43d2f19e3d3d0c45a6dafbc2efcddd04ad6b3aeac8', renamed: true },
    { file: 'Candarali.ttf', sha256: 'ff22b2841bc0aa0664b50c9215e8440f1da4f74bedd27ab33865f63f433b2681', renamed: true },
    { file: 'Candaraz.ttf', sha256: 'a873581d9f0886441bd45c5e425a734e86e063ef583b9cf8081b1aa03b871f1c', renamed: true },
    { file: 'CascadiaCode.ttf', sha256: 'cfb6a8d474018fe46d53a427e5fbee44b998822d0d3d8772914bd712cfc55ac4', renamed: false },
    { file: 'CascadiaMono.ttf', sha256: '0e141cb99609f6f10ad05313fd1807d5cc9e28658dcbb35ab162e52ff67dc718', renamed: false },
    { file: 'comic.ttf', sha256: 'fc7fbc3fb456a363f1f719b0ec62ae093c78124bb6da046006ae7e217a6b8575', renamed: true },
    { file: 'comicbd.ttf', sha256: '128fdcfdfdd358e1624c15dd1f84a4d0689e59afcdefb81f8105efb2253b9c00', renamed: true },
    { file: 'comici.ttf', sha256: '872cdefea79e25ff1a8a814109593c23ed66ba46f5bb843815d49e1ab4e0be3c', renamed: true },
    { file: 'comicz.ttf', sha256: '36eb300a76582b7d39f3d34834ce1255f0b9b2830fb2e81485c4b85a5ff7f03b', renamed: true },
    { file: 'consola.ttf', sha256: 'cf00b507b3286870cc5064ebd0633c303f70b491a4af25eec2d32df413db0179', renamed: true },
    { file: 'consolab.ttf', sha256: '7e8de70c92a891722bd3fbd623db005caab2bfe267e5dab5be46b95a44e0c7f1', renamed: true },
    { file: 'consolai.ttf', sha256: '0b5b0484cf69ae973bd39380069f141271a4c9299b8885fa2d13f42aadbefef9', renamed: true },
    { file: 'consolaz.ttf', sha256: '9bc225ec52aa8f4b88b98bb735b1908bd72c9e31a12139fafcc1bd6c86bed3b4', renamed: true },
    { file: 'cour.ttf', sha256: 'e4a66a0259718d0c8f4b6e14319b4803ced45afbddf3abba8b8c3e2006856206', renamed: true },
    { file: 'courbd.ttf', sha256: '11e629cef937cd08f942aa1bd994a71302dbe2819c72c6d4c183a623acbb421a', renamed: true },
    { file: 'courbi.ttf', sha256: '2d61f452de49b57d9ef14ce8896bc1cd2ed8285c2e9fb2e73e78a4b23f91d308', renamed: true },
    { file: 'couri.ttf', sha256: 'd82eeeb458f661d867f916d691fc6d3c53f8735fe4d5b04b54a5757321ee03e0', renamed: true },
    { file: 'ebrima.ttf', sha256: '3c5ce79b86ef4e4dd5c61d9a976c89751fe3ec35ae15dd253f3fb0745f883ef9', renamed: true },
    { file: 'ebrimabd.ttf', sha256: '08e47df2f8c6d1e94067b4e50680b232ff29c517bc1bff0c092c69f21c7549ca', renamed: true },
    { file: 'gadugi.ttf', sha256: '0ec2bdbfc2ba99d9fb05b6f7c511e7ab8b7c055e2d644570ad777455d6e9796d', renamed: true },
    { file: 'gadugib.ttf', sha256: 'c96226cba7f50e94b534a5f8ade6a54f48a03be7c73360524eda5cbce4de34b6', renamed: true },
    { file: 'Inkfree.ttf', sha256: 'c8ab96bc49ec1dc36936b5973fc143ca222c1a33ab27b87071a3bbc44d34ca9a', renamed: true },
    { file: 'LeelaUIb.ttf', sha256: '15f58cff987dce2ca1e7740ca6001b8e4e2589ea80898fdedca26d2726979f7e', renamed: true },
    { file: 'LeelawUI.ttf', sha256: 'ca9a670f12d0e47c20441012a22f78ab17c1b126818e0e887ef7db6ecf5e76b4', renamed: true },
    { file: 'LeelUIsl.ttf', sha256: 'f7a9d979c27baad75ebcd41ea45113919576c2e56af9ffd483dd9d0ef9272a25', renamed: true },
    { file: 'malgun.ttf', sha256: '7a183cf1c6c56b9609fcc16eda8b5229fbc11758a21e669ec00343239b02192f', renamed: true },
    { file: 'malgunbd.ttf', sha256: 'e8cbc0b2afcc14fb45dfb6086d5102c0b23a96e7b6e708f3122acde1b86c9082', renamed: true },
    { file: 'malgunsl.ttf', sha256: 'c0ca810a242c4482594182db40f0f9d35a3d51bb2eeac750e6e867b2110eb00e', renamed: true },
    { file: 'micross.ttf', sha256: '89b42a12ea0379133fb2f4a1d1bd53058fb61e2343c1d509452d5761acc85b7a', renamed: true },
    { file: 'mingliub.ttc', sha256: '8f8afdb3ec7047118f6dc51b29d395e697ee6770d0afd0cd407457e2ad6e93cb', renamed: true },
    { file: 'mmrtext.ttf', sha256: 'f9b362b1e0e09880cdf71852e3cc6dd6f7babb3fb6c12019f39af2135c6233cc', renamed: true },
    { file: 'mmrtextb.ttf', sha256: 'a96d49aa45e2800f49734578e5f5c1eaeb142e60a1fe1a4cc4d885170be5dcfe', renamed: true },
    { file: 'monbaiti.ttf', sha256: 'bf15e713f2ae14f85201ad31752054b0d88adb64634d9a1f5a7bc032f981ff89', renamed: true },
    { file: 'msjh.ttc', sha256: '1fd5fc7046e0eea753988ee06d1a5a731df68475614e2174fbba9b4800f392ac', renamed: true },
    { file: 'msjhbd.ttc', sha256: '7d55cd4801102131d991630cea74534dcf73a9fabf4a33e54fe05dfb4f5aa790', renamed: true },
    { file: 'msjhl.ttc', sha256: '15f1162a68b5859f246d89ea62aed711b1994817c72e78e3df5d205c89c5c6e8', renamed: true },
    { file: 'mvboli.ttf', sha256: '5dfd7a4c708caeefae42cdb9540946de042beeb8c069dfde0dbc14c2fa0705ae', renamed: true },
    { file: 'Nirmala.ttc', sha256: 'ad02cdfc06e144ac45f318e8e5a64cbe04c7479d4beb91d25f5a319a466b1767', renamed: true },
    { file: 'NotoSerifSC-VF.ttf', sha256: 'a4aed9985a5916fbf6690456f8732a9fccd517938e353165d4142b4f11a39280', renamed: true },
    SANS_SERIF_COLLECTION,
    { file: 'segmdl2.ttf', sha256: 'a2efc8b8e51fbd031a7142a1ade8866fa904c0c349511abc579ee53f8a926f31', renamed: true },
    { file: 'SegoeIcons.ttf', sha256: 'af496bd8ed18e8b45ea9c914bb3319204ab4fac450e0f4d3aab62bac6c02e5e9', renamed: false },
    { file: 'segoesc.ttf', sha256: 'b24aa49a4bcb99a0ffc60cad77f00941e4b121153d8b0a519c03719d9be6004e', renamed: true },
    { file: 'segoescb.ttf', sha256: '6cd482205e1390b32a2b6327e1e5039424e346172c187074eac12006bc51935e', renamed: true },
    { file: 'segoeui.ttf', sha256: '704eada12961a27fd271f7d3b09e2066520e758390c1776744eff430fee30f6e', renamed: true },
    { file: 'segoeuib.ttf', sha256: 'b169e636719880976a97e94e3b1cb3dbe5f4a38eabc037bf9f2a9165154c3ad2', renamed: true },
    { file: 'segoeuii.ttf', sha256: 'f9feaeee8b20751c15700b4fb03571b335f52e91edece7fb7aa1ceaa6eeb0db7', renamed: true },
    { file: 'segoeuil.ttf', sha256: '0dbddf9e20b2dc0facd568c877aa1155b3597c09a7ca41d00ca580af25d1cc51', renamed: true },
    { file: 'segoeuisl.ttf', sha256: '288a8e3fcd0f6090881dcc469b557f55e0a85864abe1cc24330bb4f08105f69b', renamed: true },
    { file: 'segoeuiz.ttf', sha256: 'f2ecff1a943929f07a7b872c948b1de57fe688ac7d0bab6fc9f624c95a97dbfe', renamed: true },
    { file: 'seguibl.ttf', sha256: 'bdf29c9b7484c631f19d6ef436a63d15f8a1a82bc856f1a0f6906c41a097d2b1', renamed: true },
    { file: 'seguibli.ttf', sha256: '6efcb158b0093bdeb6c308a93e10c2240e6510b99b756d9583cb59b7e219aaf9', renamed: true },
    { file: 'seguiemj.ttf', sha256: '451df9bb5546055af625ff86aa72695df43e8e170b4c6c1316fe44e9c7a22f7c', renamed: true },
    { file: 'seguihis.ttf', sha256: 'a162ceeaf701b55d11c542daf1c39c52bfaf686496505bff2eb75ca24814c136', renamed: true },
    { file: 'seguili.ttf', sha256: '07bbf002d8dccb6bf7db8e31207076bf357fe92b1e5f82a20d2c941d59ebeb96', renamed: true },
    { file: 'seguisb.ttf', sha256: '6c3fd894b19950b10c34bf64069ef821eaf2f58f959146306fee5b367472e501', renamed: true },
    { file: 'seguisbi.ttf', sha256: '16847ed882097cd1c0d45c63b6d75c3021f2133c64db03796f57dac198d0b2ad', renamed: true },
    { file: 'seguisli.ttf', sha256: '032eb41f836c3d6fd765dc4c287ea87f7f0c392a454ffc58d7e5fbe29d1fee86', renamed: true },
    { file: 'seguisym.ttf', sha256: 'a4a35dcc62cd30e1a6c97b695ecef83e59d2b149e3af834f6a49f11851d56b37', renamed: true },
    { file: 'SegUIVar.ttf', sha256: '27ca1ab4bd5ad3b0404ee6a9a03b143408dbd7e5a4c9e4b2054639c03fc0f682', renamed: false },
    { file: 'SitkaVF-Italic.ttf', sha256: '74d4b98aabe85e16cb2fa6583c93f9f17642234d030a38462c36d1bcdde65928', renamed: true },
    { file: 'SitkaVF.ttf', sha256: '9f71aabf76ccc757d25e18801d6a37e45cacc8b74c8b42a19e9f36ca99eef594', renamed: true },
    { file: 'sylfaen.ttf', sha256: 'ac278d932d59558a76817e98051b1dae53867aa81ad83e5198b1b4c4b8066a08', renamed: true },
    { file: 'tahoma.ttf', sha256: '9af03d4ad44a3b413d92f7de48b94aa7cc8a1471a75d498406eae837f62ee1d1', renamed: true },
    { file: 'tahomabd.ttf', sha256: 'b16ed1a15e0cabea8d41d9f8899c253cd61ac466af5e3980d02bd0cf311c2267', renamed: true },
    { file: 'times.ttf', sha256: '931c5de5c70401d9324d5014c123802b4fb753000360ceb2f56c589403cd58c5', renamed: true },
    { file: 'timesbd.ttf', sha256: '54fbe2c70af7c85a97bed0573227e3ccc4b2486012e3ca2a40c6bc77065846f5', renamed: true },
    { file: 'timesbi.ttf', sha256: '3a29d114cb5229e8dbda5bef6c69be4a210a13b7277de4d66e9fc86963226f6c', renamed: true },
    { file: 'timesi.ttf', sha256: 'e7f7a88b65188328aea58670f955022e23c712f55679524729da1e4e03c49d88', renamed: true },
    { file: 'YuGothB.ttc', sha256: 'd923a57f781f06198167da4f58287be7ac64a954a47aff4295e078a42b4b68b2', renamed: true },
    { file: 'YuGothL.ttc', sha256: '0acf409fc61e1560ea0384f8c72bf87c6fa7282077420657979680ee21dad2a4', renamed: true },
    { file: 'YuGothM.ttc', sha256: 'cb2021bbfe40b21ec564848b8d702125661594e1b4f1eb2e77fd8a98b485cf19', renamed: true },
    { file: 'YuGothR.ttc', sha256: 'cd24b5617c1e26572b0a7fe7e558f7121ca42c36f7b50e8d9216ac222a1c0a93', renamed: true }
  ] },
  // Windows 10 computer, Windows 10 window: Sans Serif Collection, under its own name.
  win10host: { prefix: '', folder: 'win11', files: [SANS_SERIF_COLLECTION] }
}

const windowsFolder = () => process.env.WINDIR ?? 'C:\\Windows'
const userFonts = () => join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
const USER_FONTS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const exists = (path: string) => access(path).then(() => true, () => false)
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const installedName = (set: PrismFontSet, font: FontFile) => font.renamed ? `${FONT_SETS[set].prefix}-${font.file}` : font.file

/** The set's font files as installed for the user: renamed "<prefix>-<file>", or under their own names. */
export const fontSetInstalledNames = (set: PrismFontSet): { name: string; renamed: boolean }[] =>
  FONT_SETS[set].files.map((font) => ({ name: installedName(set, font), renamed: font.renamed }))

/** Whether this user (or Windows, for fonts kept under their own names) has the set's fonts. */
export async function otherWindowsFontsInstalled(set: PrismFontSet, folder = userFonts(), systemFolder = join(windowsFolder(), 'Fonts')): Promise<boolean> {
  for (const font of FONT_SETS[set].files) {
    const name = installedName(set, font)
    if (!await exists(join(folder, name)) && (font.renamed || !await exists(join(systemFolder, name)))) return false
  }
  return true
}

// name IDs: 1 family, 3 unique ID, 4 full name, 16 typographic family, 18 compatible full (Mac),
// 21 WWS family; 6 PostScript name, 20 PostScript CID findfont name, 25 variations PostScript prefix.
const SPACED_NAME_IDS = new Set([1, 3, 4, 16, 18, 21])
const POSTSCRIPT_NAME_IDS = new Set([6, 20, 25])

function checksum(data: Buffer): number {
  let sum = 0
  for (let at = 0; at < data.length; at += 4) {
    const word = Buffer.alloc(4)
    data.copy(word, 0, at, Math.min(at + 4, data.length))
    sum = (sum + word.readUInt32BE(0)) >>> 0
  }
  return sum
}

/** PostScript names of a variable font's named instances (fvar), which get the prefix too. */
function instancePostScriptIds(fvar: Buffer | undefined): Set<number> {
  const ids = new Set<number>()
  if (!fvar) return ids
  const axesOffset = fvar.readUInt16BE(4)
  const axisCount = fvar.readUInt16BE(8)
  const axisSize = fvar.readUInt16BE(10)
  const instanceCount = fvar.readUInt16BE(12)
  const instanceSize = fvar.readUInt16BE(14)
  if (instanceSize < axisCount * 4 + 6) return ids
  for (let index = 0; index < instanceCount; index++) {
    const id = fvar.readUInt16BE(axesOffset + axisCount * axisSize + index * instanceSize + 4 + axisCount * 4)
    if (id !== 0xffff && id !== 6) ids.add(id)
  }
  return ids
}

function renameNameTable(old: Buffer, prefix: string, extraPostScriptIds: Set<number>): Buffer {
  const format = old.readUInt16BE(0)
  const count = old.readUInt16BE(2)
  const storage = old.readUInt16BE(4)
  const strings: Buffer[] = []
  const records: number[][] = []
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12
    const [platform, encoding, language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((field) => old.readUInt16BE(at + field))
    let text = old.subarray(storage + offset, storage + offset + length)
    const add = SPACED_NAME_IDS.has(nameId) ? `${prefix} ` : POSTSCRIPT_NAME_IDS.has(nameId) || extraPostScriptIds.has(nameId) ? prefix : ''
    if (add) text = Buffer.concat([platform === 1 ? Buffer.from(add, 'latin1') : Buffer.from(add, 'utf16le').swap16(), text])
    records.push([platform, encoding, language, nameId, text.length])
    strings.push(Buffer.from(text))
  }
  const langTags: Buffer[] = []
  if (format === 1) {
    const tagCount = old.readUInt16BE(6 + count * 12)
    for (let index = 0; index < tagCount; index++) {
      const at = 6 + count * 12 + 2 + index * 4
      langTags.push(Buffer.from(old.subarray(storage + old.readUInt16BE(at + 2), storage + old.readUInt16BE(at + 2) + old.readUInt16BE(at))))
    }
  }
  const headerLength = 6 + count * 12 + (format === 1 ? 2 + langTags.length * 4 : 0)
  const header = Buffer.alloc(headerLength)
  header.writeUInt16BE(format, 0)
  header.writeUInt16BE(count, 2)
  header.writeUInt16BE(headerLength, 4)
  let offset = 0
  records.forEach(([platform, encoding, language, nameId, length], index) => {
    const at = 6 + index * 12
    for (const [field, value] of [[0, platform], [2, encoding], [4, language], [6, nameId], [8, length], [10, offset]]) header.writeUInt16BE(value, at + field)
    offset += length
  })
  if (format === 1) {
    header.writeUInt16BE(langTags.length, 6 + count * 12)
    langTags.forEach((tag, index) => {
      const at = 6 + count * 12 + 2 + index * 4
      header.writeUInt16BE(tag.length, at)
      header.writeUInt16BE(offset, at + 2)
      offset += tag.length
    })
  }
  if (offset > 0xffff) throw new Error('字体名称太长')
  return Buffer.concat([header, ...strings, ...langTags])
}

/**
 * The font (or every face of a .ttc collection) with `prefix` before its family, full, unique and
 * PostScript names, named instances' PostScript names included; glyphs and layout untouched.
 */
export function prefixedFont(data: Buffer, prefix: string): Buffer {
  const collection = data.toString('latin1', 0, 4) === 'ttcf'
  const faceOffsets = collection ? Array.from({ length: data.readUInt32BE(8) }, (_, index) => data.readUInt32BE(12 + index * 4)) : [0]
  // Tables by their place in the file: faces of a collection may share them.
  const tables = new Map<string, Buffer>()
  const faces = faceOffsets.map((face) => {
    const entries = Array.from({ length: data.readUInt16BE(face + 4) }, (_, index) => {
      const record = face + 12 + index * 16
      const tag = data.toString('latin1', record, record + 4)
      const offset = data.readUInt32BE(record + 8)
      const length = data.readUInt32BE(record + 12)
      const key = `${offset}:${length}`
      if (!tables.has(key)) tables.set(key, Buffer.from(data.subarray(offset, offset + length)))
      return { tag, key }
    })
    return { sfntVersion: data.readUInt32BE(face), header: Buffer.from(data.subarray(face + 4, face + 12)), entries }
  })
  for (const face of faces) {
    const name = face.entries.find((entry) => entry.tag === 'name')
    const head = face.entries.find((entry) => entry.tag === 'head')
    if (!name || !head) throw new Error('不是字体文件')
    const fvar = face.entries.find((entry) => entry.tag === 'fvar')
    const renamedKey = `${name.key}:renamed`
    if (!tables.has(renamedKey)) tables.set(renamedKey, renameNameTable(tables.get(name.key)!, prefix, instancePostScriptIds(fvar && tables.get(fvar.key))))
    name.key = renamedKey
    tables.get(head.key)!.writeUInt32BE(0, 8)
  }
  // Collection header, each face's table directory, then every table once, 4-byte aligned.
  const headerLength = collection ? 12 + faces.length * 4 : 0
  const directoryLengths = faces.map((face) => 12 + face.entries.length * 16)
  let at = headerLength + directoryLengths.reduce((sum, length) => sum + length, 0)
  const placed = new Map<string, number>()
  const bodies: Buffer[] = []
  for (const face of faces) {
    for (const entry of face.entries) {
      if (placed.has(entry.key)) continue
      const table = tables.get(entry.key)!
      placed.set(entry.key, at)
      const padded = Buffer.alloc((table.length + 3) & ~3)
      table.copy(padded)
      bodies.push(padded)
      at += padded.length
    }
  }
  const header = Buffer.alloc(headerLength)
  if (collection) {
    header.write('ttcf', 0, 'latin1')
    header.writeUInt32BE(0x00010000, 4)
    header.writeUInt32BE(faces.length, 8)
  }
  let directoryAt = headerLength
  const directories = faces.map((face, index) => {
    if (collection) header.writeUInt32BE(directoryAt, 12 + index * 4)
    directoryAt += directoryLengths[index]
    const directory = Buffer.alloc(directoryLengths[index])
    directory.writeUInt32BE(face.sfntVersion, 0)
    face.header.copy(directory, 4)
    face.entries.forEach((entry, entryIndex) => {
      const record = 12 + entryIndex * 16
      const table = tables.get(entry.key)!
      directory.write(entry.tag, record, 'latin1')
      directory.writeUInt32BE(checksum(table), record + 4)
      directory.writeUInt32BE(placed.get(entry.key)!, record + 8)
      directory.writeUInt32BE(table.length, record + 12)
    })
    return directory
  })
  const font = Buffer.concat([header, ...directories, ...bodies])
  if (!collection) {
    // head's checkSumAdjustment makes a single font add up to 0xB1B0AFBA (ignored in collections).
    const headAt = placed.get(faces[0].entries.find((entry) => entry.tag === 'head')!.key)!
    font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8)
  }
  return font
}

/** The kernel package's font folder for this set, next to chrome.exe. */
export function kernelFontsFolder(executable: string, set: PrismFontSet): string {
  return join(dirname(executable), PRISM_FONTS_FOLDER, FONT_SETS[set].folder ?? set)
}

/**
 * Installs the set's fonts from the kernel package for the current user (the user's Fonts folder
 * and HKCU's Fonts key, as for language font packs). Each file is checked against its SHA-256;
 * fonts already there are left alone.
 */
export async function installOtherWindowsFonts(set: PrismFontSet, kernelExecutable: string, logger?: AppLogger): Promise<void> {
  if (await otherWindowsFontsInstalled(set)) return
  const source = kernelFontsFolder(kernelExecutable, set)
  if (!await exists(source)) throw new Error('这个内核没有附带 Windows 字体（prism13 起附带）')
  await mkdir(userFonts(), { recursive: true })
  let installed = 0
  for (const font of FONT_SETS[set].files) {
    const name = installedName(set, font)
    const target = join(userFonts(), name)
    if (await exists(target) || (!font.renamed && await exists(join(windowsFolder(), 'Fonts', name)))) continue
    // prism13-14 kernel packages ship only the few fonts those kernels use.
    if (!await exists(join(source, font.file))) continue
    const data = await readFile(join(source, font.file))
    if (sha256(data) !== font.sha256) throw new Error(`内核附带的字体 ${font.file} 校验不对`)
    const output = font.renamed ? prefixedFont(data, FONT_SETS[set].prefix) : data
    await writeFile(target, output)
    await execFileAsync('reg.exe', ['add', USER_FONTS_KEY, '/v', fontRegistryName(output, name), '/t', 'REG_SZ', '/d', target, '/f'], { windowsHide: true })
    installed++
  }
  logger?.info('已安装另一版 Windows 的字体', { set, files: installed })
}
