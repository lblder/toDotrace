/** 古典原文摘句，简体呈现；出处与文字处理说明见 docs/checkin-quotes.md。 */
export interface Encouragement {
  readonly text: string
  /** 言论记其说话者，诗文记作者。 */
  readonly author: string
  readonly work: string
  readonly sourceUrl: string
}

const arrivalMessages = [
  {
    "text": "纸上得来终觉浅，绝知此事要躬行。",
    "author": "陆游",
    "work": "冬夜读书示子聿",
    "sourceUrl": "https://zh.wikisource.org/wiki/冬夜讀書示子聿"
  },
  {
    "text": "不积跬步，无以至千里；不积小流，无以成江海。",
    "author": "荀子",
    "work": "荀子·劝学",
    "sourceUrl": "https://zh.wikisource.org/wiki/荀子/勸學篇"
  },
  {
    "text": "知之者不如好之者，好之者不如乐之者。",
    "author": "孔子",
    "work": "论语·雍也",
    "sourceUrl": "https://zh.wikisource.org/wiki/論語/全覽"
  },
  {
    "text": "莫听穿林打叶声，何妨吟啸且徐行。",
    "author": "苏轼",
    "work": "定风波·莫听穿林打叶声",
    "sourceUrl": "https://zh.wikisource.org/wiki/定風波_(莫聽穿林打葉聲)"
  },
  {
    "text": "博学而笃志，切问而近思，仁在其中矣。",
    "author": "子夏",
    "work": "论语·子张",
    "sourceUrl": "https://zh.wikisource.org/wiki/論語/全覽"
  },
  {
    "text": "问渠那得清如许？为有源头活水来。",
    "author": "朱熹",
    "work": "观书有感·其一",
    "sourceUrl": "https://zh.wikisource.org/wiki/觀書有感"
  },
  {
    "text": "锲而不舍，金石可镂。",
    "author": "荀子",
    "work": "荀子·劝学",
    "sourceUrl": "https://zh.wikisource.org/wiki/荀子/勸學篇"
  },
  {
    "text": "悟已往之不谏，知来者之可追。",
    "author": "陶渊明",
    "work": "归去来兮辞",
    "sourceUrl": "https://zh.wikisource.org/wiki/歸去來辭並序"
  },
  {
    "text": "三人行，必有我师焉。择其善者而从之，其不善者而改之。",
    "author": "孔子",
    "work": "论语·述而",
    "sourceUrl": "https://zh.wikisource.org/wiki/論語/全覽"
  },
  {
    "text": "不登高山，不知天之高也；不临深谿，不知地之厚也。",
    "author": "荀子",
    "work": "荀子·劝学",
    "sourceUrl": "https://zh.wikisource.org/wiki/荀子/勸學篇"
  }
] as const satisfies readonly Encouragement[]

const departureMessages = [
  {
    "text": "温故而知新，可以为师矣。",
    "author": "孔子",
    "work": "论语·为政",
    "sourceUrl": "https://zh.wikisource.org/wiki/論語/全覽"
  },
  {
    "text": "行到水穷处，坐看云起时。",
    "author": "王维",
    "work": "终南别业",
    "sourceUrl": "https://zh.wikisource.org/wiki/終南別業"
  },
  {
    "text": "日知其所亡，月无忘其所能，可谓好学也已矣。",
    "author": "子夏",
    "work": "论语·子张",
    "sourceUrl": "https://zh.wikisource.org/wiki/論語/全覽"
  },
  {
    "text": "回首向来萧瑟处，归去，也无风雨也无晴。",
    "author": "苏轼",
    "work": "定风波·莫听穿林打叶声",
    "sourceUrl": "https://zh.wikisource.org/wiki/定風波_(莫聽穿林打葉聲)"
  },
  {
    "text": "学而不思则罔，思而不学则殆。",
    "author": "孔子",
    "work": "论语·为政",
    "sourceUrl": "https://zh.wikisource.org/wiki/論語/全覽"
  },
  {
    "text": "向来枉费推移力，此日中流自在行。",
    "author": "朱熹",
    "work": "观书有感·其二",
    "sourceUrl": "https://zh.wikisource.org/wiki/觀書有感"
  },
  {
    "text": "云无心以出岫，鸟倦飞而知还。",
    "author": "陶渊明",
    "work": "归去来兮辞",
    "sourceUrl": "https://zh.wikisource.org/wiki/歸去來辭並序"
  },
  {
    "text": "悦亲戚之情话，乐琴书以消忧。",
    "author": "陶渊明",
    "work": "归去来兮辞",
    "sourceUrl": "https://zh.wikisource.org/wiki/歸去來辭並序"
  }
] as const satisfies readonly Encouragement[]

/** 以服务端归属日轮换；展示无需联网，只有用户点击出处才打开外部页面。 */
export function encouragementFor(dayKey: string, action: 'arrive' | 'leave'): Encouragement {
  const messages = action === 'arrive' ? arrivalMessages : departureMessages
  const ordinal = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000)
  return messages[((ordinal % messages.length) + messages.length) % messages.length]!
}
