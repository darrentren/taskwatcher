"""
Task Watcher — Auto-detect task completion via file/folder changes
FiveM Server Management Tool
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import json
import os
import fnmatch
from datetime import datetime
from pathlib import Path

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    WATCHDOG_OK = True
except ImportError:
    WATCHDOG_OK = False

# ── Persistence ───────────────────────────────────────────────────────────────
DATA_DIR  = Path.home() / '.taskwatcher'
TASK_FILE = DATA_DIR / 'tasks.json'
DATA_DIR.mkdir(exist_ok=True)

# ── Theme ─────────────────────────────────────────────────────────────────────
BG    = '#0d1117'
PANEL = '#161b22'
CARD  = '#1f2937'
BORDR = '#30363d'
RED   = '#e63946'
GREEN = '#2d9e5f'
GOLD  = '#f0a500'
BLUE  = '#58a6ff'
TEXT  = '#e6edf3'
MUTED = '#8b949e'

# ─────────────────────────────────────────────────────────────────────────────
#  Core task logic
# ─────────────────────────────────────────────────────────────────────────────
class TaskManager:
    def __init__(self):
        self.tasks     = []
        self.observers = {}   # id -> Observer
        self._load()

    def _load(self):
        if TASK_FILE.exists():
            try:
                self.tasks = json.loads(TASK_FILE.read_text(encoding='utf-8'))
            except Exception:
                self.tasks = []

    def _save(self):
        TASK_FILE.write_text(json.dumps(self.tasks, indent=2, ensure_ascii=False), encoding='utf-8')

    def add(self, name, watch_path, pattern, auto_complete, description):
        task = {
            'id':           str(int(datetime.now().timestamp() * 1000)),
            'name':         name,
            'watch_path':   watch_path,
            'pattern':      pattern or '*',
            'auto_complete':auto_complete,
            'description':  description,
            'status':       'watching' if watch_path else 'pending',
            'created':      datetime.now().isoformat(),
            'completed':    None,
            'last_change':  None,
        }
        self.tasks.append(task)
        self._save()
        return task

    def complete(self, task_id):
        for t in self.tasks:
            if t['id'] == task_id:
                t['status']    = 'done'
                t['completed'] = datetime.now().isoformat()
                self._save()
                self._stop(task_id)
                return t

    def reset(self, task_id):
        for t in self.tasks:
            if t['id'] == task_id:
                t['status']      = 'watching' if t.get('watch_path') else 'pending'
                t['completed']   = None
                t['last_change'] = None
                self._save()
                return t

    def delete(self, task_id):
        self._stop(task_id)
        self.tasks = [t for t in self.tasks if t['id'] != task_id]
        self._save()

    def on_file_change(self, task_id, changed_file):
        for t in self.tasks:
            if t['id'] == task_id and t['status'] != 'done':
                t['last_change'] = datetime.now().isoformat()
                if t['auto_complete']:
                    t['status']    = 'done'
                    t['completed'] = datetime.now().isoformat()
                    self._stop(task_id)
                self._save()
                return t

    def start_watch(self, task, callback):
        if not WATCHDOG_OK or not task.get('watch_path'):
            return
        task_id = task['id']
        pattern = task.get('pattern', '*')
        self._stop(task_id)

        mgr = self

        class _Handler(FileSystemEventHandler):
            def _matches(self, path):
                return pattern == '*' or fnmatch.fnmatch(os.path.basename(path), pattern)

            def on_modified(self, event):
                if not event.is_directory and self._matches(event.src_path):
                    changed = mgr.on_file_change(task_id, event.src_path)
                    if changed:
                        callback(changed)

            def on_created(self, event):
                if not event.is_directory and self._matches(event.src_path):
                    changed = mgr.on_file_change(task_id, event.src_path)
                    if changed:
                        callback(changed)

        try:
            obs = Observer()
            obs.schedule(_Handler(), task['watch_path'], recursive=True)
            obs.start()
            self.observers[task_id] = obs
        except Exception as e:
            print(f'[TaskWatcher] Watch failed for {task["name"]}: {e}')

    def _stop(self, task_id):
        if task_id in self.observers:
            try:
                self.observers[task_id].stop()
                self.observers[task_id].join(timeout=2)
            except Exception:
                pass
            del self.observers[task_id]

    def stop_all(self):
        for tid in list(self.observers):
            self._stop(tid)


# ─────────────────────────────────────────────────────────────────────────────
#  Main window
# ─────────────────────────────────────────────────────────────────────────────
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('Task Watcher — Server Management')
        self.geometry('950x600')
        self.minsize(700, 400)
        self.configure(bg=BG)

        self.mgr = TaskManager()
        self._build()
        self._refresh()
        self._start_all()
        self.protocol('WM_DELETE_WINDOW', self._on_close)

    # ── UI ────────────────────────────────────────────────────────────────────
    def _build(self):
        # Header
        hdr = tk.Frame(self, bg=RED, height=54)
        hdr.pack(fill='x')
        hdr.pack_propagate(False)
        tk.Label(hdr, text='⚡  Task Watcher', bg=RED, fg='white',
                 font=('Segoe UI', 15, 'bold'), padx=18).pack(side='left')
        tk.Label(hdr, text='Auto-detects task completion when files change',
                 bg=RED, fg='#fecaca', font=('Segoe UI', 9)).pack(side='left', padx=4)

        # Toolbar
        bar = tk.Frame(self, bg=PANEL, pady=7)
        bar.pack(fill='x')
        for label, cmd, fg in [
            ('＋  New Task',   self._dlg_add,       BLUE),
            ('✓  Mark Done',   self._manual_done,   GREEN),
            ('↺  Reset',       self._reset,         GOLD),
            ('✕  Delete',      self._delete,        RED),
        ]:
            tk.Button(bar, text=label, command=cmd, bg=CARD, fg=fg,
                      activebackground=BORDR, activeforeground=fg,
                      relief='flat', padx=13, pady=5,
                      font=('Segoe UI', 10), cursor='hand2', bd=0
                      ).pack(side='left', padx=(10, 0))

        # Filter pills
        self._filter = tk.StringVar(value='all')
        pill_frame = tk.Frame(bar, bg=PANEL)
        pill_frame.pack(side='right', padx=12)
        tk.Label(pill_frame, text='Show:', bg=PANEL, fg=MUTED,
                 font=('Segoe UI', 9)).pack(side='left', padx=(0, 4))
        for val, lbl in [('all','All'), ('watching','Watching'), ('done','Done'), ('pending','Pending')]:
            tk.Radiobutton(pill_frame, text=lbl, variable=self._filter, value=val,
                           bg=PANEL, fg=TEXT, selectcolor=CARD,
                           activebackground=PANEL, font=('Segoe UI', 9),
                           command=self._refresh
                           ).pack(side='left', padx=2)

        # Tree
        tree_frame = tk.Frame(self, bg=BG)
        tree_frame.pack(fill='both', expand=True, padx=12, pady=10)

        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('Treeview',
                        background=CARD, foreground=TEXT, fieldbackground=CARD,
                        borderwidth=0, font=('Segoe UI', 10), rowheight=34)
        style.configure('Treeview.Heading',
                        background=PANEL, foreground=MUTED,
                        borderwidth=0, font=('Segoe UI', 9, 'bold'))
        style.map('Treeview', background=[('selected', BORDR)])

        cols = ('status', 'name', 'watch_path', 'pattern', 'last_change', 'completed')
        self.tree = ttk.Treeview(tree_frame, columns=cols, show='headings', selectmode='browse')

        widths = [('status', 'Status', 110, False),
                  ('name',        'Task',          200, True),
                  ('watch_path',  'Watching Path', 280, True),
                  ('pattern',     'Pattern',        80, False),
                  ('last_change', 'Last Change',   130, False),
                  ('completed',   'Completed',     130, False)]

        for col, heading, w, stretch in widths:
            self.tree.heading(col, text=heading, anchor='w')
            self.tree.column(col, width=w, minwidth=60, stretch=stretch)

        self.tree.tag_configure('done',     foreground=GREEN)
        self.tree.tag_configure('watching', foreground=BLUE)
        self.tree.tag_configure('pending',  foreground=MUTED)

        vsb = ttk.Scrollbar(tree_frame, orient='vertical', command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side='left', fill='both', expand=True)
        vsb.pack(side='right', fill='y')

        self.tree.bind('<<TreeviewSelect>>', self._on_select)

        # Detail bar
        det = tk.Frame(self, bg=PANEL, height=70)
        det.pack(fill='x', padx=12, pady=(0, 6))
        det.pack_propagate(False)
        self._detail = tk.StringVar(value='Select a task to see details.')
        tk.Label(det, textvariable=self._detail, bg=PANEL, fg=MUTED,
                 font=('Segoe UI', 9), justify='left', anchor='nw',
                 padx=14, pady=8, wraplength=880).pack(fill='both')

        # Status bar
        sb = tk.Frame(self, bg=BORDR, height=26)
        sb.pack(fill='x', side='bottom')
        sb.pack_propagate(False)
        self._status = tk.StringVar(value='Ready')
        tk.Label(sb, textvariable=self._status, bg=BORDR, fg=MUTED,
                 font=('Segoe UI', 9), padx=12).pack(side='left', pady=3)

        if not WATCHDOG_OK:
            tk.Label(sb, text='⚠  watchdog not installed — open run.bat then install it',
                     bg=BORDR, fg=GOLD, font=('Segoe UI', 9), padx=12
                     ).pack(side='right', pady=3)

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _fmt(self, iso):
        if not iso:
            return '—'
        try:
            return datetime.fromisoformat(iso).strftime('%d/%m  %H:%M:%S')
        except Exception:
            return str(iso)[:16]

    def _status_label(self, s):
        return {'done': '✅  Done', 'watching': '👁  Watching', 'pending': '⏳  Pending'}.get(s, s)

    def _sel_id(self):
        s = self.tree.selection()
        return s[0] if s else None

    def _sel_task(self):
        tid = self._sel_id()
        return next((t for t in self.mgr.tasks if t['id'] == tid), None) if tid else None

    # ── Refresh ───────────────────────────────────────────────────────────────
    def _refresh(self):
        prev = self._sel_id()
        self.tree.delete(*self.tree.get_children())
        filt = self._filter.get()

        for t in self.mgr.tasks:
            if filt != 'all' and t['status'] != filt:
                continue
            self.tree.insert('', 'end', iid=t['id'], tags=(t['status'],), values=(
                self._status_label(t['status']),
                t['name'],
                t.get('watch_path') or '—',
                t.get('pattern', '*'),
                self._fmt(t.get('last_change')),
                self._fmt(t.get('completed')),
            ))

        if prev and self.tree.exists(prev):
            self.tree.selection_set(prev)

        done     = sum(1 for t in self.mgr.tasks if t['status'] == 'done')
        watching = sum(1 for t in self.mgr.tasks if t['status'] == 'watching')
        pending  = sum(1 for t in self.mgr.tasks if t['status'] == 'pending')
        self._status.set(
            f'{len(self.mgr.tasks)} tasks  •  '
            f'👁 {watching} watching  •  ✅ {done} done  •  ⏳ {pending} pending'
        )

    def _on_select(self, _event=None):
        t = self._sel_task()
        if not t:
            return
        lines = [f"📋  {t['name']}"]
        if t.get('description'):
            lines.append(f"📝  {t['description']}")
        if t.get('watch_path'):
            lines.append(f"📁  {t['watch_path']}   (pattern: {t.get('pattern','*')})")
        if t.get('last_change'):
            lines.append(f"🕐  Last file change detected: {self._fmt(t['last_change'])}")
        if t.get('completed'):
            lines.append(f"✅  Completed at: {self._fmt(t['completed'])}")
        self._detail.set('     '.join(lines))

    # ── Task change callback (called from watcher thread) ─────────────────────
    def _on_change(self, task):
        def _update():
            self._refresh()
            if task['status'] == 'done':
                self._notify(task['name'])
        self.after(0, _update)

    def _notify(self, name):
        popup = tk.Toplevel(self)
        popup.title('')
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        popup.geometry(f'300x85+{sw-320}+{sh-130}')
        popup.configure(bg=PANEL)
        popup.attributes('-topmost', True)
        popup.overrideredirect(True)
        popup.attributes('-alpha', 0.96)

        tk.Frame(popup, bg=GREEN, height=4).pack(fill='x')
        tk.Label(popup, text='✅  Task Auto-Completed!', bg=PANEL, fg=GREEN,
                 font=('Segoe UI', 11, 'bold'), pady=6).pack()
        tk.Label(popup, text=name, bg=PANEL, fg=TEXT,
                 font=('Segoe UI', 10), wraplength=280).pack()
        tk.Button(popup, text='Dismiss', command=popup.destroy,
                  bg=CARD, fg=MUTED, relief='flat', padx=8, pady=2
                  ).pack(pady=4)
        self.bell()
        self.lift()
        popup.after(6000, lambda: popup.destroy() if popup.winfo_exists() else None)

    # ── Actions ───────────────────────────────────────────────────────────────
    def _dlg_add(self):
        TaskDialog(self, 'Add Task', self._save_task)

    def _save_task(self, data):
        task = self.mgr.add(
            name         = data['name'],
            watch_path   = data['watch_path'],
            pattern      = data['pattern'],
            auto_complete= data['auto_complete'],
            description  = data['description'],
        )
        if task.get('watch_path') and task['status'] == 'watching':
            self.mgr.start_watch(task, self._on_change)
        self._refresh()
        self._status.set(f'Task added: {task["name"]}')

    def _manual_done(self):
        t = self._sel_task()
        if not t:
            messagebox.showwarning('No Selection', 'Select a task first.', parent=self)
            return
        if t['status'] == 'done':
            messagebox.showinfo('Already Done', 'This task is already completed.', parent=self)
            return
        self.mgr.complete(t['id'])
        self._refresh()

    def _reset(self):
        t = self._sel_task()
        if not t:
            messagebox.showwarning('No Selection', 'Select a task first.', parent=self)
            return
        if messagebox.askyesno('Reset Task', f'Reset "{t["name"]}" back to watching?', parent=self):
            self.mgr.reset(t['id'])
            if t.get('watch_path'):
                self.mgr.start_watch(t, self._on_change)
            self._refresh()

    def _delete(self):
        t = self._sel_task()
        if not t:
            messagebox.showwarning('No Selection', 'Select a task first.', parent=self)
            return
        if messagebox.askyesno('Delete', f'Delete "{t["name"]}"?', parent=self):
            self.mgr.delete(t['id'])
            self._refresh()

    def _start_all(self):
        for t in self.mgr.tasks:
            if t['status'] == 'watching' and t.get('watch_path'):
                self.mgr.start_watch(t, self._on_change)

    def _on_close(self):
        self.mgr.stop_all()
        self.destroy()


# ─────────────────────────────────────────────────────────────────────────────
#  Add / Edit Task Dialog
# ─────────────────────────────────────────────────────────────────────────────
class TaskDialog(tk.Toplevel):
    def __init__(self, parent, title, on_save):
        super().__init__(parent)
        self.title(title)
        self.geometry('500x400')
        self.configure(bg=PANEL)
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        self._on_save = on_save
        self._build()

    def _entry(self, parent, var, **kw):
        return tk.Entry(parent, textvariable=var, bg=CARD, fg=TEXT,
                        insertbackground=TEXT, relief='flat',
                        font=('Segoe UI', 11), bd=8, **kw)

    def _label(self, text):
        tk.Label(self, text=text, bg=PANEL, fg=MUTED,
                 font=('Segoe UI', 9), anchor='w').pack(fill='x', padx=20, pady=(10, 2))

    def _build(self):
        self._name  = tk.StringVar()
        self._desc  = tk.StringVar()
        self._path  = tk.StringVar()
        self._pat   = tk.StringVar(value='*')
        self._auto  = tk.BooleanVar(value=True)

        self._label('Task Name  *')
        self._entry(self, self._name).pack(fill='x', padx=20)

        self._label('Description (optional)')
        self._entry(self, self._desc).pack(fill='x', padx=20)

        self._label('Watch Folder / File')
        pf = tk.Frame(self, bg=PANEL)
        pf.pack(fill='x', padx=20)
        self._entry(pf, self._path, font=('Segoe UI', 10)).pack(side='left', fill='x', expand=True)
        tk.Button(pf, text='Browse…', command=self._browse,
                  bg=CARD, fg=BLUE, relief='flat', padx=10, bd=0,
                  font=('Segoe UI', 9)
                  ).pack(side='right', padx=(4, 0))

        self._label('File Pattern  (e.g. *.lua  *.json  *.cfg  —  * = any file)')
        self._entry(self, self._pat, font=('Segoe UI', 10)).pack(fill='x', padx=20)

        tk.Checkbutton(self, text='Auto-complete task when file change is detected',
                       variable=self._auto, bg=PANEL, fg=TEXT,
                       selectcolor=CARD, activebackground=PANEL,
                       font=('Segoe UI', 10)
                       ).pack(anchor='w', padx=20, pady=12)

        bf = tk.Frame(self, bg=PANEL)
        bf.pack(fill='x', padx=20, pady=(4, 20))
        tk.Button(bf, text='Cancel', command=self.destroy,
                  bg=CARD, fg=MUTED, relief='flat', padx=14, pady=7, bd=0
                  ).pack(side='right', padx=(6, 0))
        tk.Button(bf, text='  Save Task  ', command=self._save,
                  bg=RED, fg='white', relief='flat', padx=14, pady=7, bd=0,
                  font=('Segoe UI', 10, 'bold')
                  ).pack(side='right')

    def _browse(self):
        path = filedialog.askdirectory(title='Select folder to watch', parent=self)
        if path:
            self._path.set(path)

    def _save(self):
        name = self._name.get().strip()
        if not name:
            messagebox.showerror('Error', 'Task name is required.', parent=self)
            return
        self._on_save({
            'name':         name,
            'description':  self._desc.get().strip(),
            'watch_path':   self._path.get().strip(),
            'pattern':      self._pat.get().strip() or '*',
            'auto_complete':self._auto.get(),
        })
        self.destroy()


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    App().mainloop()
