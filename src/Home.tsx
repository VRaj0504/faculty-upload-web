import { Icon, type IconName } from './icons';
import { NAV, toneVars, type Tab, type Tone } from './nav';

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function firstName(name: string) {
  const cleaned = name.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '').trim();
  if (cleaned.includes('@')) return '';
  const first = cleaned.split(/\s+/)[0] ?? '';
  return first ? first[0]!.toUpperCase() + first.slice(1) : '';
}

const LOGOS = [
  { x: '4%', y: '8%', s: 54, d: 15, delay: 0 },
  { x: '22%', y: '58%', s: 38, d: 19, delay: -6 },
  { x: '47%', y: '6%', s: 44, d: 17, delay: -3 },
  { x: '66%', y: '52%', s: 62, d: 21, delay: -9 },
  { x: '83%', y: '10%', s: 40, d: 16, delay: -12 },
  { x: '92%', y: '60%', s: 34, d: 18, delay: -5 },
];

type TileDef = {
  tab: Tab;
  title: string;
  sub: string;
  icon: IconName;
  tone: Tone | 'ink';
  big?: boolean;
  count?: number | null;
};

export default function Home({
  name,
  medicalWaiting,
  onOpen,
}: {
  name: string;
  medicalWaiting: number | null;
  onOpen: (tab: Tab) => void;
}) {
  const now = new Date();
  const first = firstName(name);

  const tiles: TileDef[] = [
    { tab: 'resources', title: 'File a resource', sub: 'Notes, question papers and slides for your classes', icon: 'upload', tone: 'blue', big: true },
    {
      tab: 'medicalLeaves',
      title: 'Medical leaves',
      sub:
        medicalWaiting === null
          ? 'Doctor → HOD → teachers'
          : medicalWaiting === 0
            ? 'Nothing waiting on you'
            : `${medicalWaiting} waiting on you`,
      icon: 'medical',
      tone: 'lilac',
      count: medicalWaiting,
    },
    { tab: 'attendance', title: 'Attendance', sub: 'Mark a class or upload a register', icon: 'check', tone: 'mint' },
    { tab: 'announcements', title: 'Announce', sub: 'Notify a class on the app', icon: 'megaphone', tone: 'peach' },
    { tab: 'myTimetable', title: 'My timetable', sub: 'Where you teach this week', icon: 'clock', tone: 'ink' },
  ];

  return (
    <div className="panel-enter home-wrap">
      <div className="home-bg" aria-hidden="true">
        <span className="home-blob hb1" />
        <span className="home-blob hb2" />
        <span className="home-blob hb3" />
        {LOGOS.map((l, i) => (
          <span
            key={i}
            className="home-logo"
            style={{ left: l.x, top: l.y, width: l.s, height: l.s, fontSize: l.s * 0.38, animationDuration: `${l.d}s`, animationDelay: `${l.delay}s` }}
          >
            IS
          </span>
        ))}
      </div>
      <div className="home-head">
        <div>
          <h1 className="home-hello">
            {greeting(now)}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="home-date">
            {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </div>

      <div className="bento">
        {tiles.map((t) => (
          <button
            key={t.tab}
            type="button"
            className={`tile${t.big ? ' tile-big' : ''}${t.tone === 'ink' ? ' tile-ink' : ''}`}
            style={t.tone === 'ink' ? undefined : toneVars(t.tone)}
            onClick={() => onOpen(t.tab)}
          >
            <span className="tile-icon">
              <Icon name={t.icon} size={t.big ? 26 : 21} />
            </span>
            {t.count ? (
              <span className="tile-count" aria-label={`${t.count} waiting`}>{t.count}</span>
            ) : (
              <span className="tile-arrow" aria-hidden="true">
                <Icon name="arrow" size={16} />
              </span>
            )}
            <span>
              <p className="tile-title">{t.title}</p>
              <p className="tile-sub">{t.sub}</p>
            </span>
          </button>
        ))}
      </div>

      <div className="section-title">
        <h2>All tools</h2>
        <span>{NAV.reduce((n, g) => n + g.items.length, 0)} tools in {NAV.length} groups</span>
      </div>
      <div className="groups">
        {NAV.map((g) => (
          <section className="group-card" key={g.id} onMouseEnter={g.prefetch}>
            <div className="group-card-head">
              <span className="group-card-icon" style={toneVars(g.tone)}>
                <Icon name={g.icon} size={18} />
              </span>
              <div>
                <div className="group-card-title">{g.label}</div>
                <div className="group-card-sub">{g.hint}</div>
              </div>
            </div>
            <div className="group-links">
              {g.items.map((i) => (
                <button key={i.tab} type="button" className="group-link" onClick={() => onOpen(i.tab)}>
                  <span>{i.label}</span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
