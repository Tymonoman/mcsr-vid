export const SEED_ICON_PALETTE: Record<string, string> = {
  // Backgrounds & Base
  A: "#1d579c", // ocean blue
  K: "#8cbbe3", // pale sky
  g: "#6b9e3b", // grass green
  p: "#c6ab78", // dirt path (lighter to contrast with oak)
  s: "#dbd3a0", // sand / sandstone base
  S: "#b3a971", // dark sandstone / shadow
  N: "#681615", // netherrack crimson
  B: "#1a1820", // dark sky (ruined portal)
  
  // Motif colours
  D: "#2c1b0d", // very dark outline (village, shipwreck, chest)
  O: "#21182b", // obsidian / dark doorway
  w: "#8f6a48", // oak planks
  W: "#b5d6e0", // window glass
  r: "#6b4226", // dark roof
  c: "#7d7d7d", // cobblestone
  m: "#523821", // broken mast / dark wood
  T: "#d16428", // orange terracotta
  U: "#35d6c4", // cyan diamond
  P: "#8c31ff", // purple portal
  G: "#f0c93d", // gold
  Q: "#e2483f", // crimson red X
};

// 16x16 grid size
export const SEED_ICON_GRIDS: Record<string, string[]> = {
  VILLAGE: [
    "gggggggggggggggg",
    "gggggDDDDDDggggg",
    "gggDDrrrrrrDDggg",
    "ggDDrrrrrrrrDDgg",
    "gDDwwwwwwwwwwDDg",
    "gDDwWWwwwwwwwDDg",
    "gDDwWWwwwwOOwDDg",
    "gDDwwwwwwwOOGDDg",
    "gDDcccwwwwOOcDDg",
    "ggDDccccccOOccDg",
    "ggppppppppOOpppg",
    "pppppppppppppppp",
    "gppppppppppppppg",
    "gggppppppppppggg",
    "gggggggggggggggg",
    "gggggggggggggggg",
  ],
  SHIPWRECK: [
    "AAAAAAAAAAAAAADA",
    "AAAAAAAAAAAADmmD",
    "AAAAAAAAAAADmmDA",
    "AAAAAAAAAAADmDAA",
    "AAAAAAAAADmmDAAA",
    "AAAAAAADDmmDAAAA",
    "AAAAADDwwwwDDAAA",
    "AAAADwwwwwwwwDAA",
    "AAADwwwwwwwwwDAA",
    "AADwDwwwwwDwwDAA",
    "ADDwwDwwwwwwDDAA",
    "ADwwwwDwwwwwwDAA",
    "AAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAss",
    "AAAAAAAAAAAAssss",
    "AAAAAAAAAAssssss",
  ],
  DESERT_TEMPLE: [
    "KKKKKKKKKKKKKKKK",
    "KKKKKKKKKKKKKKKK",
    "SSSSSKKKKKKSSSSS",
    "SsssSKKKKKKSsssS",
    "SsssSSSSSSSSsssS",
    "SsssSssssssSsssS",
    "STTsSssTTssSTTsS",
    "SsssSssTTssSsssS",
    "STTsSTTTTTTSTTsS",
    "SsssSssUUssSsssS",
    "SsssSSOOOOSSsssS",
    "SsssSOOOOOOSsssS",
    "SsssSOOOOOOSsssS",
    "SsssSOOOOOOSsssS",
    "SssssssssssssssS",
    "SSSSSSSSSSSSSSSS",
  ],
  RUINED_PORTAL: [
    "BBBBBBBBBBBBBBBB",
    "BBDDDDDDDDBBBBBB",
    "BDDOOOOOODDBBBBB",
    "BDOOPPPPOODBBBBB",
    "BDOOPPPPOODBBBBB",
    "BBBPPPPPBBBBBBBB",
    "BDOOPPPPOODBBBBB",
    "BDOOPPPPOODBBBBB",
    "BDOOPPPPOODDDDBB",
    "BDOOPPPPOODGGGDB",
    "BDOOPPPPOODGGGDB",
    "BDDOOOOOODDGGGDB",
    "NBDDDDDDDDDDDDDB",
    "NNNNNNNNNNNNNNNN",
    "NNNNNNNNNNNNNNNN",
    "NNNNNNNNNNNNNNNN",
  ],
  BURIED_TREASURE: [
    "AAAAAAssssssssss",
    "AAAAssssssssssss",
    "AAssssssssssssss",
    "ssssssssssssssss",
    "ssQssQssssssssss",
    "sssQQssssDDDDDDD",
    "sssQQsssDDwwwwwD",
    "ssQssQssDwmwwwmD",
    "ssssssssDwmwGwmD",
    "ssssssssDwmwwwmD",
    "sssssssssDwwwwDs",
    "ssssssssssssssss",
    "ssssssssssssssss",
    "ssssssssssssssss",
    "ssssssssssssssss",
    "ssssssssssssssss",
  ],
};
