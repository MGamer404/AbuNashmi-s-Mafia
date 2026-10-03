/**
 * ============================================================================
 * AbuNashmi's Mafia — internationalisation
 * ============================================================================
 *
 * The engine holds no display text at all: it speaks in role ids, phase names
 * and error codes, and this module is the only place those become words a
 * player reads. Adding a language therefore never means touching game logic.
 *
 * Two things worth knowing:
 *
 *   - ARABIC. `dir` flips to 'rtl' and the CSS is written entirely in logical
 *     properties, so there is no second stylesheet. Arabic script must not be
 *     letter-spaced (it breaks the joins between letters), which is why the
 *     font token swap in tokens.css also raises line-height rather than
 *     tightening tracking.
 *
 *   - PLACEHOLDERS. `t()` interpolates `{name}` tokens. Interpolated values
 *     are inserted as plain text by the caller (never innerHTML), and any
 *     caller that places a name inside a larger RTL sentence should wrap it in
 *     `isolate()` so a Latin name does not reorder the Arabic around it.
 */

export const LANGS = Object.freeze(['en', 'ar']);
export const DEFAULT_LANG = 'en';

const STORAGE_KEY = 'mafia.lang';

/* ========================================================================== */
/* Dictionaries                                                                */
/* ========================================================================== */

const EN = {
  'app.name': "AbuNashmi's Mafia",
  'app.tagline': 'A game of deduction, for a table of friends.',
  'app.loading': 'Loading…',
  'app.noScript':
    'This game is played entirely in your browser and needs JavaScript enabled. Turn it on and reload to play.',

  /* ---- roles ---- */
  'role.VILLAGER': 'Civilian',
  'role.MAFIA': 'Mafia',
  'role.DOCTOR': 'Doctor',
  'role.DETECTIVE': 'Detective',
  'role.VILLAGER.desc': 'You have no power but your voice. Find the Mafia before they find you.',
  'role.MAFIA.desc': 'Each night, choose someone to eliminate. By day, look innocent.',
  'role.DOCTOR.desc': 'Each night, choose someone to protect from the Mafia.',
  'role.DETECTIVE.desc': 'Each night, learn whether one player is Mafia.',

  'team.TOWN': 'Town',
  'team.MAFIA': 'Mafia',
  'team.DRAW': 'Nobody',

  'verdict.MAFIA': 'is Mafia',
  'verdict.NOT_MAFIA': 'is not Mafia',

  /* ---- phases ---- */
  'phase.LOBBY': 'Waiting room',
  'phase.ROLE_DEAL': 'Dealing cards',
  'phase.NIGHT': 'Night',
  'phase.DAY_ANNOUNCE': 'Morning',
  'phase.DAY_DISCUSS': 'Discussion',
  'phase.DAY_VOTE': 'The vote',
  'phase.DAY_RUNOFF': 'Runoff',
  'phase.LAST_WORDS': 'Last words',
  'phase.ENDED': 'Game over',

  /* ---- phase instructions ---- */
  'hint.NIGHT.mafia': 'Choose who to eliminate.',
  'hint.NIGHT.doctor': 'Choose who to protect tonight.',
  'hint.NIGHT.detective': 'Choose who to investigate.',
  'hint.NIGHT.villager': 'Sleep. The night will pass.',
  'hint.DAY_DISCUSS': 'Talk it out. Accuse, defend, listen.',
  'hint.DAY_VOTE': 'Cast your vote. You may change it until the timer runs out.',
  'hint.DAY_RUNOFF': 'The vote was tied. Choose between the tied players.',
  'hint.LAST_WORDS': 'You may say one last thing.',
  'hint.waiting': 'Waiting for the others…',

  /* ---- lobby ---- */
  'lobby.title': 'Waiting room',
  'lobby.players': 'Players',
  'lobby.seats': '{count} of {max} seats',
  'lobby.needMore': 'At least {min} players are needed to begin.',
  'lobby.ready': 'Ready',
  'lobby.notReady': 'Not ready',
  'lobby.start': 'Deal the cards',
  'lobby.startHint': 'Everyone is seated. Begin when you are ready.',
  'lobby.you': 'You',
  'lobby.host': 'Host',
  'lobby.moderator': 'Moderator',
  'lobby.spectator': 'Spectator',
  'lobby.away': 'Away',

  /* ---- home ---- */
  'home.create': 'Create a game',
  'home.createHint': 'Start a room and share its code.',
  'home.join': 'Join a game',
  'home.joinHint': 'Enter a code from your host.',
  'home.name': 'Your name',
  'home.namePlaceholder': 'e.g. AbuNashmi',
  'home.roomCode': 'Room code',
  'home.roomCodePlaceholder': 'ABC234',
  'home.codeCopied': 'Code copied',
  'home.share': 'Share this code with your table:',
  'home.joinBtn': 'Join',
  'home.back': 'Back',
  'home.spectate': 'Watch instead',
  'home.tabCreate': 'Create a room',
  'home.tabJoin': 'Join a room',
  'home.tabsLabel': 'Start or join a game',
  'home.createBtn': 'Create room',
  'home.joinGo': 'Join room',
  'home.createNote': 'A room code appears on the next screen — share it with your table.',
  'home.codeHint':
    'Six letters and numbers. The letters I, L, O and the digits 0 and 1 are never used, so they are never needed.',
  'home.iModerate': 'I’ll moderate',
  'home.iModerate.hint':
    'You’ll see every role and can steer the game. Leave it off and the game runs itself on timers.',
  'home.joinAsMod': 'Join as moderator',
  'home.joinAsMod.hint': 'Only if the table has asked you to referee.',
  'home.how': 'How to play',
  'home.how.p1':
    'Everyone at the table is dealt a role in secret. The Mafia picks someone to kill each night; the Doctor protects one person; the Detective learns whether one person is Mafia. Everyone else is a Civilian.',
  'home.how.p2':
    'By day the table argues and votes. Whoever gets the most votes is eliminated and their role is revealed. The town wins by eliminating every Mafia; the Mafia win when they equal the number of everyone else.',
  'home.how.p3':
    'Five players is the minimum. Roles are fixed before the first card is turned, and the game publishes a hash at the deal and the matching secret at the end, so anyone can check it afterwards.',

  /* ---- game chrome ---- */
  'game.room': 'Room',
  'game.round': 'Round {n}',
  'game.yourRole': 'Your role',
  'game.you': 'You',
  'game.dead': 'Eliminated',
  'game.alive': '{count} alive',
  'game.secret': 'Keep this to yourself.',
  'game.revealRole': 'Tap to reveal',
  'game.hide': 'Hide',

  /* ---- night report ---- */
  'report.noDeath': 'Nobody died in the night.',
  'report.death': '{name} did not survive the night.',
  'report.saved': 'The Doctor saved someone in the night.',
  'report.firstNight': 'The first night passes quietly.',
  'report.killed': '{name} was eliminated by the vote.',
  'report.noElimination': 'The town could not agree. Nobody was eliminated.',
  'report.tie': 'The vote was tied between {names}.',
  'report.investigation': '{name} {verdict}.',

  /* ---- voting ---- */
  'vote.cast': 'Vote',
  'vote.change': 'Change vote',
  'vote.abstain': 'Abstain',
  'vote.youVoted': 'You voted for {name}',
  'vote.youAbstained': 'You abstained',
  'vote.tally': 'Votes',
  'vote.submitted': '{count} of {total} have voted',
  'vote.tiedWith': 'tied',
  'vote.eliminated': 'eliminated',
  'vote.runoff': 'Tied: {names}. A runoff decides it.',

  /* ---- chat ---- */
  'chat.title': 'Chat',
  'chat.placeholder': 'Say something…',
  'chat.send': 'Send',
  'chat.public': 'Table',
  'chat.mafia': 'Mafia',
  'chat.dead': 'The departed',
  'chat.empty': 'No messages yet.',
  'chat.silenced': 'The dead may not speak to the living.',

  /* ---- last words ---- */
  'lastWords.title': 'Last words',
  'lastWords.placeholder': 'Anything you want to say…',
  'lastWords.send': 'Say it',
  'lastWords.skip': 'Say nothing',
  'lastWords.waiting': 'Waiting for their last words…',

  /* ---- end ---- */
  'end.townWins': 'The Town wins',
  'end.mafiaWins': 'The Mafia wins',
  'end.draw': 'The game is a draw',
  'end.reason.ALL_MAFIA_ELIMINATED': 'Every Mafia was found and eliminated.',
  'end.reason.MAFIA_REACHED_PARITY': 'The Mafia matched the Town, seat for seat.',
  'end.reason.STALEMATE': 'Round after round passed with no progress. Nobody won.',
  'end.reveal': 'The deal',
  'end.rematch': 'Play again',
  'end.newRoom': 'New room',
  'end.proof': 'Deal proof',
  'end.proofHint': 'The roles were fixed before the first card was turned.',

  /* ---- moderator ---- */
  'mod.title': 'Moderator',
  'mod.you': 'You are the moderator',
  'mod.hostMode': 'Host mode',
  'mod.mode.AUTOMATED': 'Automated',
  'mod.mode.MODERATED': 'Host needed',
  'mod.mode.AUTOMATED.desc': 'The game runs itself on timers.',
  'mod.mode.MODERATED.desc': 'You steer: end phases, keep the pace.',
  'mod.style': 'Input mode',
  'mod.style.PLAYERS_ACT': 'Players act',
  'mod.style.PLAYERS_ACT.desc': 'Each player taps their own choice.',
  'mod.style.MOD_ENTERS': 'Moderator enters',
  'mod.style.MOD_ENTERS.desc': 'You enter every choice at the table.',
  'mod.style.both': 'Both work at once — switch whenever you like.',
  'mod.next': 'Next phase',
  'mod.advance': 'Advance',
  'mod.running': 'Running — {time} left',
  'mod.paused': 'Timer paused',
  'mod.armTimer': 'Arm timer',
  'mod.disarmTimer': 'Pause timer',
  'mod.remaining': 'Duration',
  'mod.duration': 'Duration',
  'mod.nightOrder': 'Night order',
  'mod.step.MAFIA': 'Wake the Mafia',
  'mod.step.DOCTOR': 'Wake the Doctor',
  'mod.step.DETECTIVE': 'Wake the Detective',
  'mod.step.SLEEP': 'Everyone sleeps',
  'mod.wake': 'Wake',
  'mod.sleep': 'Sleep',
  'mod.rolereveal': 'Who is who',
  'mod.seat': 'Seat',
  'mod.submitted': '{done} of {total} acted',
  'mod.waiting': 'Waiting',
  'mod.override': 'Moderator entry',
  'mod.overrideHint': 'Set the outcome yourself. This always wins over what players tapped.',
  'mod.clear': 'Clear',
  'mod.apply': 'Apply',
  'mod.liveTally': 'Show live vote counts',
  'mod.deadChat': 'Let the departed talk',
  'mod.chatEnabled': 'Allow chat',
  'mod.revealOnElimination': 'Reveal the role on elimination',
  'mod.revealSave': 'Announce a successful save',
  'mod.kick': 'Remove',
  'mod.settings': 'Settings',
  'mod.close': 'Close',

  /* ---- decision slots ---- */
  'slot.KILL': 'The Mafia’s kill',
  'slot.PROTECT': 'The Doctor’s protection',
  'slot.INVESTIGATE': 'The Detective’s investigation',
  'slot.VOTE': 'The vote',

  /* ---- errors ---- */
  'error.ROOM_FULL': 'That room is full.',
  'error.BAD_PLAYER_COUNT': 'A game needs between {min} and {max} players.',
  'error.NO_SUCH_SEAT': 'That seat is no longer at the table.',
  'error.NO_OPEN_SLOT': 'There is nothing to decide right now.',
  'error.STALE_PHASE': 'That decision arrived too late and was ignored.',
  'error.NOT_ELIGIBLE': 'You cannot act this round.',
  'error.TARGET_NOT_IN_SPACE': 'That is not a legal choice.',
  'error.INVALID_TARGET': 'That is not a legal choice.',
  'error.TARGET_DEAD': 'They are already out of the game.',
  'error.CANNOT_KILL_MAFIA': 'The Mafia do not turn on their own.',
  'error.CANNOT_SELF_PROTECT': 'The Doctor may not protect themselves.',
  'error.CANNOT_REPEAT_PROTECT': 'The Doctor may not protect the same person twice in a row.',
  'error.CANNOT_INVESTIGATE_SELF': 'The Detective cannot investigate themselves.',
  'error.CANNOT_SELF_VOTE': 'You cannot vote for yourself.',
  'error.ALREADY_VOTED': 'Your vote is locked in.',
  'error.ABSTAIN_NOT_ALLOWED': 'Abstaining is not allowed in this game.',
  'error.NOT_CONNECTED': 'Lost connection to the host.',
  'error.ROOM_NOT_FOUND': 'No room with that code. Check it and try again.',
  'error.ROOM_CLOSED': 'The host has closed the room.',
  'error.HOST_GONE': 'The host left. The game cannot continue.',
  'error.NAME_REQUIRED': 'Please enter a name.',
  'error.NAME_TAKEN': 'Someone at this table is already using that name.',
  'error.WRONG_VERSION': 'You and the host are running different versions of the game.',
  'error.UNKNOWN': 'Something went wrong.',

  /* ---- connection ---- */
  'conn.connecting': 'Connecting…',
  'conn.connected': 'Connected',
  'conn.reconnecting': 'Reconnecting…',
  'conn.disconnected': 'Disconnected',
  'conn.hostLost': 'The host left the table.',

  /* ---- accessibility ---- */
  'a11y.cardBack': 'A face-down role card',
  'a11y.yourCard': 'Your role card: {role}',
  'a11y.mute': 'Mute sound',
  'a11y.unmute': 'Unmute sound',
  'a11y.language': 'Switch language',
  'a11y.playerList': 'Players at the table',
  'a11y.voteTally': 'Vote tally',
  'a11y.copyCode': 'Copy room code',
  'a11y.skip': 'Skip to content',
};

const AR = {
  'app.name': 'مافيا أبو نشمي',
  'app.tagline': 'لعبة استنتاج حول طاولة من الأصدقاء.',
  'app.loading': 'جارٍ التحميل…',
  'app.noScript':
    'تُلعب هذه اللعبة بالكامل داخل متصفحك وتحتاج إلى تفعيل JavaScript. فعّله ثم أعد تحميل الصفحة لتلعب.',

  'role.VILLAGER': 'مواطن',
  'role.MAFIA': 'مافيا',
  'role.DOCTOR': 'طبيب',
  'role.DETECTIVE': 'محقق',
  'role.VILLAGER.desc': 'لا تملك سوى صوتك. اكتشف المافيا قبل أن يكتشفوك.',
  'role.MAFIA.desc': 'كل ليلة اختر شخصًا للتخلص منه. وفي النهار تظاهر بالبراءة.',
  'role.DOCTOR.desc': 'كل ليلة اختر شخصًا لحمايته من المافيا.',
  'role.DETECTIVE.desc': 'كل ليلة اعرف ما إذا كان أحد اللاعبين من المافيا.',

  'team.TOWN': 'المدينة',
  'team.MAFIA': 'المافيا',
  'team.DRAW': 'لا أحد',

  'verdict.MAFIA': 'من المافيا',
  'verdict.NOT_MAFIA': 'ليس من المافيا',

  'phase.LOBBY': 'غرفة الانتظار',
  'phase.ROLE_DEAL': 'توزيع البطاقات',
  'phase.NIGHT': 'الليل',
  'phase.DAY_ANNOUNCE': 'الصباح',
  'phase.DAY_DISCUSS': 'النقاش',
  'phase.DAY_VOTE': 'التصويت',
  'phase.DAY_RUNOFF': 'جولة الإعادة',
  'phase.LAST_WORDS': 'كلمة أخيرة',
  'phase.ENDED': 'انتهت اللعبة',

  'hint.NIGHT.mafia': 'اختاروا من تريدون التخلص منه.',
  'hint.NIGHT.doctor': 'اختر من تحميه هذه الليلة.',
  'hint.NIGHT.detective': 'اختر من تحقق معه.',
  'hint.NIGHT.villager': 'نم. سيمرّ الليل.',
  'hint.DAY_DISCUSS': 'تحدثوا. اتهموا، دافعوا، وأصغوا.',
  'hint.DAY_VOTE': 'أدلِ بصوتك. يمكنك تغييره حتى انتهاء الوقت.',
  'hint.DAY_RUNOFF': 'تعادلت الأصوات. اختاروا بين المتعادلين.',
  'hint.LAST_WORDS': 'يمكنك أن تقول شيئًا أخيرًا.',
  'hint.waiting': 'في انتظار الباقين…',

  'lobby.title': 'غرفة الانتظار',
  'lobby.players': 'اللاعبون',
  'lobby.seats': '{count} من أصل {max} مقعدًا',
  'lobby.needMore': 'تحتاج اللعبة إلى {min} لاعبين على الأقل للبدء.',
  'lobby.ready': 'جاهز',
  'lobby.notReady': 'غير جاهز',
  'lobby.start': 'وزّع البطاقات',
  'lobby.startHint': 'أخذ الجميع مقاعدهم. ابدأ حين تشاء.',
  'lobby.you': 'أنت',
  'lobby.host': 'المضيف',
  'lobby.moderator': 'المشرف',
  'lobby.spectator': 'مشاهد',
  'lobby.away': 'غائب',

  'home.create': 'أنشئ لعبة',
  'home.createHint': 'افتح غرفة وشارك رمزها.',
  'home.join': 'انضم إلى لعبة',
  'home.joinHint': 'أدخل الرمز الذي أرسله لك المضيف.',
  'home.name': 'اسمك',
  'home.namePlaceholder': 'مثال: أبو نشمي',
  'home.roomCode': 'رمز الغرفة',
  'home.roomCodePlaceholder': 'ABC234',
  'home.codeCopied': 'تم نسخ الرمز',
  'home.share': 'شارك هذا الرمز مع طاولتك:',
  'home.joinBtn': 'انضم',
  'home.back': 'رجوع',
  'home.spectate': 'المشاهدة بدلًا من ذلك',
  'home.tabCreate': 'افتح غرفة',
  'home.tabJoin': 'انضم إلى غرفة',
  'home.tabsLabel': 'ابدأ لعبة أو انضم إليها',
  'home.createBtn': 'افتح الغرفة',
  'home.joinGo': 'انضم إلى الغرفة',
  'home.createNote': 'سيظهر رمز الغرفة في الشاشة التالية — شاركه مع طاولتك.',
  'home.codeHint':
    'ستة أحرف وأرقام. لا تُستخدم الحروف I و L و O ولا الرقمان 0 و 1، فلن تحتاجها أبدًا.',
  'home.iModerate': 'سأكون المشرف',
  'home.iModerate.hint':
    'سترى كل الأدوار ويمكنك توجيه سير اللعبة. اتركه فارغًا وستدير اللعبة نفسها بالمؤقتات.',
  'home.joinAsMod': 'انضم كمشرف',
  'home.joinAsMod.hint': 'فقط إذا طلبت منك الطاولة الإشراف.',
  'home.how': 'كيف تلعب',
  'home.how.p1':
    'يُوزَّع على كل من على الطاولة دور سرّي. تختار المافيا شخصًا لقتله كل ليلة، ويحمي الطبيب شخصًا واحدًا، ويعرف المحقق ما إذا كان أحدهم من المافيا. أمّا الباقون فهم مدنيون.',
  'home.how.p2':
    'وفي النهار تتجادل الطاولة وتصوّت. ومن يحصل على أكثر الأصوات يُقصى ويُكشف دوره. يفوز البلدة بإقصاء كل أفراد المافيا، وتفوز المافيا حين يصبح عددها مساويًا لعدد الباقين.',
  'home.how.p3':
    'الحد الأدنى خمسة لاعبين. تُثبَّت الأدوار قبل قلب أول بطاقة، وتنشر اللعبة بصمة عند التوزيع والسرّ المطابق في النهاية، فيمكن لأي أحد التحقق منها لاحقًا.',

  'game.room': 'الغرفة',
  'game.round': 'الجولة {n}',
  'game.yourRole': 'دورك',
  'game.you': 'أنت',
  'game.dead': 'مُستبعد',
  'game.alive': '{count} على قيد الحياة',
  'game.secret': 'احتفظ بهذا لنفسك.',
  'game.revealRole': 'اضغط للكشف',
  'game.hide': 'إخفاء',

  'report.noDeath': 'لم يمت أحد هذه الليلة.',
  'report.death': '{name} لم ينجُ من الليلة.',
  'report.saved': 'أنقذ الطبيب أحدهم هذه الليلة.',
  'report.firstNight': 'تمرّ الليلة الأولى بهدوء.',
  'report.killed': '{name} أُقصي بالتصويت.',
  'report.noElimination': 'لم تتفق المدينة. لم يُستبعد أحد.',
  'report.tie': 'تعادلت الأصوات بين {names}.',
  'report.investigation': '{name} {verdict}.',

  'vote.cast': 'صوّت',
  'vote.change': 'غيّر صوتك',
  'vote.abstain': 'امتنع',
  'vote.youVoted': 'صوّتت لـ {name}',
  'vote.youAbstained': 'امتنعت عن التصويت',
  'vote.tally': 'الأصوات',
  'vote.submitted': 'صوّت {count} من {total}',
  'vote.tiedWith': 'متعادل',
  'vote.eliminated': 'مُستبعد',
  'vote.runoff': 'تعادل: {names}. تحسمه جولة الإعادة.',

  'chat.title': 'المحادثة',
  'chat.placeholder': 'قل شيئًا…',
  'chat.send': 'أرسل',
  'chat.public': 'الطاولة',
  'chat.mafia': 'المافيا',
  'chat.dead': 'الرحيل',
  'chat.empty': 'لا رسائل بعد.',
  'chat.silenced': 'لا يجوز للموتى مخاطبة الأحياء.',

  'lastWords.title': 'كلمة أخيرة',
  'lastWords.placeholder': 'أي شيء تريد قوله…',
  'lastWords.send': 'قلها',
  'lastWords.skip': 'لا تقل شيئًا',
  'lastWords.waiting': 'في انتظار كلمته الأخيرة…',

  'end.townWins': 'فازت المدينة',
  'end.mafiaWins': 'فازت المافيا',
  'end.draw': 'انتهت اللعبة بالتعادل',
  'end.reason.ALL_MAFIA_ELIMINATED': 'تم كشف كل أفراد المافيا وإقصاؤهم.',
  'end.reason.MAFIA_REACHED_PARITY': 'تساوى عدد المافيا مع المدينة مقعدًا بمقعد.',
  'end.reason.STALEMATE': 'مرّت جولات دون أي تقدم. لم يفز أحد.',
  'end.reveal': 'التوزيع',
  'end.rematch': 'العب مرة أخرى',
  'end.newRoom': 'غرفة جديدة',
  'end.proof': 'إثبات التوزيع',
  'end.proofHint': 'حُددت الأدوار قبل كشف أول بطاقة.',

  'mod.title': 'المشرف',
  'mod.you': 'أنت المشرف',
  'mod.hostMode': 'نمط الإدارة',
  'mod.mode.AUTOMATED': 'تلقائي',
  'mod.mode.MODERATED': 'بمشرف',
  'mod.mode.AUTOMATED.desc': 'اللعبة تدير نفسها بالمؤقتات.',
  'mod.mode.MODERATED.desc': 'أنت تدير الإيقاع وتنهي المراحل.',
  'mod.style': 'طريقة الإدخال',
  'mod.style.PLAYERS_ACT': 'اللاعبون يختارون',
  'mod.style.PLAYERS_ACT.desc': 'كل لاعب يضغط خياره بنفسه.',
  'mod.style.MOD_ENTERS': 'المشرف يدخل',
  'mod.style.MOD_ENTERS.desc': 'أنت تدخل كل اختيارات الطاولة.',
  'mod.style.both': 'كلاهما يعمل معًا — بدّل متى شئت.',
  'mod.next': 'المرحلة التالية',
  'mod.advance': 'تقدّم',
  'mod.running': 'يعمل — بقي {time}',
  'mod.paused': 'المؤقت متوقف',
  'mod.armTimer': 'شغّل المؤقت',
  'mod.disarmTimer': 'أوقف المؤقت',
  'mod.remaining': 'المدة',
  'mod.duration': 'المدة',
  'mod.nightOrder': 'ترتيب الليل',
  'mod.step.MAFIA': 'أيقظ المافيا',
  'mod.step.DOCTOR': 'أيقظ الطبيب',
  'mod.step.DETECTIVE': 'أيقظ المحقق',
  'mod.step.SLEEP': 'الجميع ينام',
  'mod.wake': 'إيقاظ',
  'mod.sleep': 'نوم',
  'mod.rolereveal': 'من هو من',
  'mod.seat': 'المقعد',
  'mod.submitted': '{done} من {total} أدّوا دورهم',
  'mod.waiting': 'بالانتظار',
  'mod.override': 'إدخال المشرف',
  'mod.overrideHint': 'حدّد النتيجة بنفسك. هذا يتقدم دائمًا على اختيارات اللاعبين.',
  'mod.clear': 'مسح',
  'mod.apply': 'تطبيق',
  'mod.liveTally': 'إظهار العدّ المباشر للأصوات',
  'mod.deadChat': 'السماح للموتى بالحديث',
  'mod.chatEnabled': 'السماح بالدردشة',
  'mod.revealOnElimination': 'كشف الدور عند الإقصاء',
  'mod.revealSave': 'إعلان نجاح الإنقاذ',
  'mod.kick': 'إزالة',
  'mod.settings': 'الإعدادات',
  'mod.close': 'إغلاق',

  /* ---- decision slots ---- */
  'slot.KILL': 'قرار المافيا',
  'slot.PROTECT': 'حماية الطبيب',
  'slot.INVESTIGATE': 'تحقيق المحقق',
  'slot.VOTE': 'التصويت',

  'error.ROOM_FULL': 'هذه الغرفة ممتلئة.',
  'error.BAD_PLAYER_COUNT': 'تحتاج اللعبة إلى ما بين {min} و{max} لاعبين.',
  'error.NO_SUCH_SEAT': 'هذا المقعد لم يعد على الطاولة.',
  'error.NO_OPEN_SLOT': 'لا يوجد ما يُحسم الآن.',
  'error.STALE_PHASE': 'وصل هذا القرار متأخرًا فتم تجاهله.',
  'error.NOT_ELIGIBLE': 'لا يمكنك التصرف في هذه الجولة.',
  'error.TARGET_NOT_IN_SPACE': 'هذا ليس خيارًا مسموحًا.',
  'error.INVALID_TARGET': 'هذا ليس خيارًا مسموحًا.',
  'error.TARGET_DEAD': 'لقد خرج من اللعبة بالفعل.',
  'error.CANNOT_KILL_MAFIA': 'المافيا لا تتخلى عن أفرادها.',
  'error.CANNOT_SELF_PROTECT': 'لا يمكن للطبيب حماية نفسه.',
  'error.CANNOT_REPEAT_PROTECT': 'لا يمكن للطبيب حماية الشخص نفسه مرتين متتاليتين.',
  'error.CANNOT_INVESTIGATE_SELF': 'لا يمكن للمحقق التحقيق مع نفسه.',
  'error.CANNOT_SELF_VOTE': 'لا يمكنك التصويت لنفسك.',
  'error.ALREADY_VOTED': 'صوتك مثبّت.',
  'error.ABSTAIN_NOT_ALLOWED': 'الامتناع غير مسموح في هذه اللعبة.',
  'error.NOT_CONNECTED': 'انقطع الاتصال بالمضيف.',
  'error.ROOM_NOT_FOUND': 'لا توجد غرفة بهذا الرمز. تأكد منه وحاول مجددًا.',
  'error.ROOM_CLOSED': 'أغلق المضيف الغرفة.',
  'error.HOST_GONE': 'غادر المضيف. لا يمكن للعبة أن تستمر.',
  'error.NAME_REQUIRED': 'يرجى إدخال اسم.',
  'error.NAME_TAKEN': 'هناك من يستخدم هذا الاسم بالفعل على هذه الطاولة.',
  'error.WRONG_VERSION': 'أنت والمضيف تستخدمان إصدارين مختلفين من اللعبة.',
  'error.UNKNOWN': 'حدث خطأ ما.',

  'conn.connecting': 'جارٍ الاتصال…',
  'conn.connected': 'متصل',
  'conn.reconnecting': 'إعادة الاتصال…',
  'conn.disconnected': 'غير متصل',
  'conn.hostLost': 'غادر المضيف الطاولة.',

  'a11y.cardBack': 'بطاقة دور مقلوبة',
  'a11y.yourCard': 'بطاقة دورك: {role}',
  'a11y.mute': 'كتم الصوت',
  'a11y.unmute': 'تشغيل الصوت',
  'a11y.language': 'تغيير اللغة',
  'a11y.playerList': 'اللاعبون على الطاولة',
  'a11y.voteTally': 'عدّ الأصوات',
  'a11y.copyCode': 'نسخ رمز الغرفة',
  'a11y.skip': 'تخطَّ إلى المحتوى',
};

const DICTS = Object.freeze({ en: EN, ar: AR });

/* ========================================================================== */
/* State                                                                       */
/* ========================================================================== */

const IS_BROWSER = typeof document !== 'undefined';

function detectInitialLang() {
  if (!IS_BROWSER) return DEFAULT_LANG;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGS.includes(saved)) return saved;
  } catch {
    /* Storage can be unavailable in private modes; fall through to the browser's preference. */
  }
  const nav = navigator.languages?.[0] || navigator.language || '';
  return nav.toLowerCase().startsWith('ar') ? 'ar' : DEFAULT_LANG;
}

let current = detectInitialLang();

const listeners = new Set();

/* ========================================================================== */
/* API                                                                         */
/* ========================================================================== */

/** @returns {'en'|'ar'} */
export function getLang() {
  return current;
}

/** @returns {'ltr'|'rtl'} */
export function dir(lang = current) {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Look up a key, interpolating `{placeholders}`.
 *
 * A missing key returns the key itself rather than an empty string: a visible
 * `error.CANNOT_SELF_VOTE` in the UI is a bug report, whereas an empty label
 * is a mystery.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const dict = DICTS[current] || EN;
  let text = dict[key];
  if (text === undefined) text = EN[key];
  if (text === undefined) return key;
  if (!params) return text;

  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/**
 * Change language and notify subscribers. Safe to call repeatedly with the
 * same value; it is a no-op then, so callers need no guard.
 *
 * @param {'en'|'ar'} lang
 */
export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === current) return;
  current = lang;
  if (IS_BROWSER) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* Not being able to remember the choice is not a reason to refuse it. */
    }
  }
  applyDocumentLang();
  for (const fn of listeners) fn(lang);
}

export function toggleLang() {
  setLang(current === 'ar' ? 'en' : 'ar');
  return current;
}

/**
 * Subscribe to language changes.
 * @param {(lang: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Wrap a value that may be in the opposite writing direction, so it does not
 * reorder the sentence around it. Use for names inside Arabic sentences.
 *
 * @param {string} text
 * @returns {string}
 */
export function isolate(text) {
  return `⁨${text}⁩`;
}

/**
 * Reflect the current language on <html>. `lang` drives font selection and
 * hyphenation; `dir` drives the entire layout, since the stylesheet is written
 * in logical properties.
 */
export function applyDocumentLang() {
  if (!IS_BROWSER) return;
  const root = document.documentElement;
  root.setAttribute('lang', current);
  root.setAttribute('dir', dir());
}

/**
 * Build a translator bound to a fixed language — useful for rendering a
 * cached string under a language that is not the current one.
 * @param {'en'|'ar'} lang
 */
export function translatorFor(lang) {
  const dict = DICTS[lang] || EN;
  return (key, params) => {
    let text = dict[key] ?? EN[key] ?? key;
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
      );
    }
    return text;
  };
}

/** Every key present in every dictionary — used by the test suite. */
export function allKeys() {
  return [...new Set(Object.values(DICTS).flatMap((d) => Object.keys(d)))].sort();
}

/** The dictionary for a language, for tests and tooling. */
export function dictionaryFor(lang) {
  return DICTS[lang];
}
