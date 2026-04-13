/**
 * AttendEase — localStorage Database
 * Roles: 'admin' | 'teacher' | 'student'
 *
 * Storage keys:
 *   attendease_version      — schema version (triggers re-seed on mismatch)
 *   attendease_users        — user accounts
 *   attendease_session      — active session (sessionStorage)
 *   attendease_student_{id} — per-student extended data
 *   attendease_teacher_{id} — per-teacher extended data
 */

// ══════════════════════════════════════════════════════════════════════════════
//  DEVELOPER TESTING CLOCK
//  ─────────────────────────────────────────────────────────────────────────────
//  Set SIMULATED_TIME to override the real system clock for testing.
//  Use null to use the actual system clock.
//
//  ⚠ FORMAT IS 24-HOUR (HH:MM) — NO AM/PM:
//     '09:00' = 9:00 AM       '21:00' = 9:00 PM
//     '11:00' = 11:00 AM      '13:00' = 1:00 PM  ← NOT '01:00' !!
//     '01:00' = 1:00 AM  ← this is the MIDDLE OF THE NIGHT, before any class
//
//  Status rules (LATE_GRACE_MINUTES = 15 min):
//    Before class end time and within grace  → Present ✓
//    After class start + 15 min grace        → Late    ⚠
//    After class END time                    → Absent  ✗
//
//  Quick test reference:
//    null     → real clock (use this in production)
//   ── English (9:00 AM – 11:00 AM) ──────────────────────────────────────────
//    '09:00'  → Present ✓  (right on time)
//    '09:16'  → Late    ⚠  (past 9:15 grace)
//    '11:30'  → Absent  ✗  (class has ended — '11:30', NOT '01:30' !)
//   ── AP (11:00 AM – 1:00 PM) ───────────────────────────────────────────────
//    '11:00'  → Present ✓
//    '11:16'  → Late    ⚠
//    '13:30'  → Absent  ✗  (1:30 PM in 24-hr = '13:30', NOT '01:30' !)
//   ── Math (1:00 PM – 3:00 PM) ──────────────────────────────────────────────
//    '13:00'  → Present ✓
//    '13:16'  → Late    ⚠
//    '15:30'  → Absent  ✗
//   ── Science (3:00 PM – 5:00 PM) ───────────────────────────────────────────
//    '15:00'  → Present ✓
//    '15:16'  → Late    ⚠
//    '17:30'  → Absent  ✗
// ══════════════════════════════════════════════════════════════════════════════
const SIMULATED_TIME = null;   // ← null = real clock | '09:16' = Late | '11:30' = Absent (English ended) | '13:30' = Absent (AP ended)

// ══════════════════════════════════════════════════════════════════════════════
//  DEVELOPER: CLEAR ALL ATTENDANCE TIMES
//  ─────────────────────────────────────────────────────────────────────────────
//  Set to true then RELOAD the page to wipe every timeIn / timeOut record
//  for all students in all teacher sessions. Scan logs and counters are also
//  reset. Set back to false when done.
// ══════════════════════════════════════════════════════════════════════════════
const DEV_CLEAR_ATTENDANCE_TIMES = false;   // ← set to true to clear, then reload

const DB = (() => {
    const KEY = 'attendease_users';
    const VKEY = 'attendease_version';
    const SKEY = 'attendease_session';
    const VERSION = '3';  // ← bump this to force a full wipe + re-seed

    // ── Class schedules ────────────────────────────────────────────────────────
    // Each entry: start/end in 'HH:MM' 24-hr; display is the human label.
    const CLASS_SCHEDULES = {
        ENG: { name: 'English', start: '09:00', end: '11:00', display: '9:00 AM – 11:00 AM' },
        AP: { name: 'Araling Panlipunan (AP)', start: '11:00', end: '13:00', display: '11:00 AM – 1:00 PM' },
        MATH: { name: 'Mathematics', start: '13:00', end: '15:00', display: '1:00 PM – 3:00 PM' },
        SCI: { name: 'Science', start: '15:00', end: '17:00', display: '3:00 PM – 5:00 PM' },
    };

    // Minutes after class start before a scan is marked as "Late"
    const LATE_GRACE_MINUTES = 15;

    // ── Seed accounts — exactly ONE per role ───────────────────────────────────
    const SEEDS = [
        {
            id: 1, role: 'admin',
            firstname: 'Administrator', lastname: '',
            uid: 'ADMIN-001', email: 'admin@school.edu',
            username: 'admin', password: 'admin123', created: '2024-01-01'
        },
        {
            id: 2, role: 'teacher',
            firstname: 'Maria', lastname: 'Santos',
            uid: 'EMP-001', email: 'maria.santos@school.edu',
            username: 'ms.santos', password: 'teacher01', created: '2024-05-15'
        },
        {
            id: 3, role: 'student',
            firstname: 'Juan', lastname: 'Dela Cruz',
            uid: '2024-00001', email: 'juan.delacruz@school.edu',
            username: 'juan.dc', password: 'pass1234', created: '2024-06-01'
        },
    ];

    // ── Default extended student data ──────────────────────────────────────────
    const DEFAULT_STUDENT_DATA = {
        section: '',
        attendance: { present: 0, absent: 0, late: 0 },
        // { date, cls, mode:'in'|'out', time:'09:05 AM', status:'present'|'late' }
        scanLog: [],
    };

    // ── Default extended teacher data ──────────────────────────────────────────
    const DEFAULT_TEACHER_DATA = {
        classes: [
            { code: 'ENG', name: 'English', schedule: '9:00 AM – 11:00 AM', enrolled: 0, weekly: [0, 0, 0, 0, 0, 0, 0], enrolledStudents: [] },
            { code: 'AP', name: 'Araling Panlipunan (AP)', schedule: '11:00 AM – 1:00 PM', enrolled: 0, weekly: [0, 0, 0, 0, 0, 0, 0], enrolledStudents: [] },
            { code: 'MATH', name: 'Mathematics', schedule: '1:00 PM – 3:00 PM', enrolled: 0, weekly: [0, 0, 0, 0, 0, 0, 0], enrolledStudents: [] },
            { code: 'SCI', name: 'Science', schedule: '3:00 PM – 5:00 PM', enrolled: 0, weekly: [0, 0, 0, 0, 0, 0, 0], enrolledStudents: [] },
        ],
        // Keyed by "CLASSCODE_YYYY-MM-DD".
        // Each value is an array of:
        // { studentId, name, status, timeIn, timeOut, remark, excuse }
        sessions: {},
        // Array of { id, classCode, caption, attachments:[{name,dataUrl,type}], createdAt }
        announcements: [],
    };

    // ── Private helpers ────────────────────────────────────────────────────────
    function _read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
    function _write(users) { localStorage.setItem(KEY, JSON.stringify(users)); }
    function _nextId(users) { return users.length ? Math.max(...users.map(u => u.id)) + 1 : 1; }

    /** Wipe every attendease_* key from localStorage (keeps session). */
    function _purgeAll() {
        Object.keys(localStorage)
            .filter(k => k.startsWith('attendease') && k !== SKEY)
            .forEach(k => localStorage.removeItem(k));
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    return {

        /** Expose schedules and grace period for use on dashboard pages. */
        schedules: CLASS_SCHEDULES,
        lateGrace: LATE_GRACE_MINUTES,

        // ── Seed / Migration ───────────────────────────────────────────────────

        /**
         * Seed on first load — OR force a full re-seed when VERSION is bumped.
         * Wipes ALL old accounts and extended data when version mismatches.
         */
        seed() {
            if (localStorage.getItem(VKEY) === VERSION && _read() !== null) return;

            _purgeAll();
            sessionStorage.removeItem(SKEY);   // force logout of any stale session

            _write(SEEDS);
            localStorage.setItem(VKEY, VERSION);
            localStorage.setItem('attendease_teacher_2', JSON.stringify(DEFAULT_TEACHER_DATA));
            localStorage.setItem('attendease_student_3', JSON.stringify(DEFAULT_STUDENT_DATA));
            console.log('[AttendEase] Storage seeded at version', VERSION);
        },

        // ── User CRUD ──────────────────────────────────────────────────────────

        getAll() { return _read() || []; },
        getById(id) { return this.getAll().find(u => u.id === id) || null; },

        findByLogin(identifier) {
            const lower = identifier.toLowerCase();
            return this.getAll().find(
                u => u.username.toLowerCase() === lower || u.email.toLowerCase() === lower
            ) || null;
        },

        authenticate(identifier, password) {
            const user = this.findByLogin(identifier);
            return (!user || user.password !== password) ? null : user;
        },

        usernameExists(username, excludeId = null) {
            return this.getAll().some(
                u => u.username.toLowerCase() === username.toLowerCase() && u.id !== excludeId
            );
        },

        create(data) {
            const users = this.getAll();
            const newUser = { ...data, id: _nextId(users), created: new Date().toISOString().split('T')[0] };
            users.push(newUser);
            _write(users);
            if (newUser.role === 'student') {
                const k = `attendease_student_${newUser.id}`;
                if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(DEFAULT_STUDENT_DATA));
            } else if (newUser.role === 'teacher') {
                const k = `attendease_teacher_${newUser.id}`;
                if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(DEFAULT_TEACHER_DATA));
            }
            return newUser;
        },

        update(id, changes) {
            const users = this.getAll();
            const idx = users.findIndex(u => u.id === id);
            if (idx === -1) return null;
            users[idx] = { ...users[idx], ...changes };
            _write(users);
            return users[idx];
        },

        delete(id) {
            localStorage.removeItem(`attendease_student_${id}`);
            localStorage.removeItem(`attendease_teacher_${id}`);
            _write(this.getAll().filter(u => u.id !== id));
        },

        archive(id) {
            return this.update(id, { isArchived: true, archivedAt: new Date().toISOString().split('T')[0] });
        },

        restore(id) {
            return this.update(id, { isArchived: false, archivedAt: null });
        },

        generateUid(role) {
            const users = this.getAll();
            // Start count from 1 + existing count to avoid simple overlap (though deleted users might cause gaps/dupes, we'll use max if needed, but length+1 is usually sufficient for a simple system)
            const roleUsers = users.filter(u => u.role === role);
            const count = roleUsers.length > 0 ? roleUsers.length + 1 : 1;
            const year = new Date().getFullYear();
            if (role === 'student') return `${year}-${count.toString().padStart(5, '0')}`;
            if (role === 'teacher') return `EMP-${count.toString().padStart(3, '0')}`;
            return `ADMIN-${count.toString().padStart(3, '0')}`;
        },

        // ── Extended student data ──────────────────────────────────────────────

        getStudentData(userId) {
            try {
                return JSON.parse(localStorage.getItem(`attendease_student_${userId}`))
                    || JSON.parse(JSON.stringify(DEFAULT_STUDENT_DATA));
            } catch { return JSON.parse(JSON.stringify(DEFAULT_STUDENT_DATA)); }
        },

        saveStudentData(userId, data) {
            localStorage.setItem(`attendease_student_${userId}`, JSON.stringify(data));
        },

        updateStudentData(userId, changes) {
            const d = { ...this.getStudentData(userId), ...changes };
            this.saveStudentData(userId, d);
            return d;
        },

        // ── Extended teacher data ──────────────────────────────────────────────

        getTeacherData(userId) {
            try {
                return JSON.parse(localStorage.getItem(`attendease_teacher_${userId}`))
                    || JSON.parse(JSON.stringify(DEFAULT_TEACHER_DATA));
            } catch { return JSON.parse(JSON.stringify(DEFAULT_TEACHER_DATA)); }
        },

        saveTeacherData(userId, data) {
            localStorage.setItem(`attendease_teacher_${userId}`, JSON.stringify(data));
        },

        getSession_attendance(teacherId, classCode, date) {
            const td = this.getTeacherData(teacherId);
            const key = `${classCode}_${date}`;
            if (!td.sessions[key]) { td.sessions[key] = []; this.saveTeacherData(teacherId, td); }
            return td.sessions[key];
        },

        saveSession_attendance(teacherId, classCode, date, records) {
            const td = this.getTeacherData(teacherId);
            td.sessions[`${classCode}_${date}`] = records;
            this.saveTeacherData(teacherId, td);
        },

        // ── Time helpers ───────────────────────────────────────────────────────

        /**
         * Returns a Date representing "now".
         * Uses SIMULATED_TIME if set, otherwise the real system clock.
         */
        getCurrentTime() {
            if (SIMULATED_TIME) {
                const parts = SIMULATED_TIME.split(':').map(Number);
                const d = new Date();
                d.setHours(parts[0], parts[1], 0, 0);
                return d;
            }
            return new Date();
        },

        /** Format a Date as 12-hour string — e.g. "09:05 AM". */
        formatTime12h(date) {
            const h = date.getHours();
            const m = date.getMinutes();
            const ampm = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 || 12;
            return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
        },

        /** Return today's date string YYYY-MM-DD (uses simulated date if set). */
        getTodayDate() {
            return this.getCurrentTime().toISOString().split('T')[0];
        },

        /** Return the first teacher account in the DB. */
        getTeacherAccount() {
            return this.getAll().find(u => u.role === 'teacher') || null;
        },

        /**
         * Check if a student is enrolled in a class.
         * If the class has an enrolledStudents list, use it.
         * Otherwise fall back to "all students are enrolled".
         */
        isStudentEnrolled(cls, studentUid) {
            if (!cls) return false;
            if (cls.enrolledStudents && cls.enrolledStudents.length > 0) {
                return cls.enrolledStudents.includes(studentUid);
            }
            // No explicit list → treat all students as enrolled
            return true;
        },

        /**
         * Return students grouped by section.
         * Returns: { [sectionName]: [ studentUser, ... ], ... }
         */
        getStudentsBySection() {
            const students = this.getAll().filter(u => u.role === 'student');
            const groups = {};
            students.forEach(s => {
                const sd = this.getStudentData(s.id);
                const section = (sd && sd.section) ? sd.section : 'No Section';
                if (!groups[section]) groups[section] = [];
                groups[section].push(s);
            });
            return groups;
        },

        // ── Core QR scan handler ───────────────────────────────────────────────

        /**
         * Called by the student dashboard when a QR is scanned.
         * Writes the time-in / time-out into the teacher's session data.
         *
         * Rules:
         *   • Cannot time in twice on the same day for the same class.
         *   • Cannot time out without first timing in.
         *   • Cannot time out twice on the same day for the same class.
         *   • Scans after (class start + LATE_GRACE_MINUTES) are marked "Late".
         *
         * @param {object}       qrPayload      — { cls, date, ts, exp }
         * @param {object}       studentSession — the logged-in student session
         * @param {'in'|'out'}   mode
         * @returns {{ success:boolean, message:string, status?:string }}
         */
        recordStudentScan(qrPayload, studentSession, mode, options = {}) {
            const teacher = this.getTeacherAccount();
            if (!teacher) return { success: false, message: 'No teacher account found.' };

            const now = this.getCurrentTime();
            const currentTimeStr = this.formatTime12h(now);

            // Load (or init) the session record for this class + date
            const td = this.getTeacherData(teacher.id);
            const key = `${qrPayload.cls}_${qrPayload.date}`;
            if (!td.sessions[key]) td.sessions[key] = [];
            const records = td.sessions[key];

            // Find any existing record for this student
            let record = records.find(r => r.studentId === studentSession.uid);

            if (mode === 'in') {
                // ── Double time-in guard ───────────────────────────────────────
                if (record && record.timeIn) {
                    return {
                        success: false,
                        message: `Already timed in at ${record.timeIn} for this class today.`,
                    };
                }

                // ── Determine Present / Late / Absent / Too-Early ─────────────
                // Order of checks (first match wins):
                //   1. now < classStart - 15 min  → reject (too early to scan)
                //   2. now > classEnd              → absent (class already over)
                //   3. now > classStart + grace    → late
                //   4. otherwise                  → present
                const sched = CLASS_SCHEDULES[qrPayload.cls];
                let status = 'present';
                if (sched) {
                    const [sh, sm] = sched.start.split(':').map(Number);
                    const [eh, em] = sched.end.split(':').map(Number);

                    // Build boundary timestamps for today
                    const earlyLimit = new Date(now);
                    earlyLimit.setHours(sh, sm - 15, 0, 0);   // 15 min before start

                    const graceLimit = new Date(now);
                    graceLimit.setHours(sh, sm + LATE_GRACE_MINUTES, 0, 0);

                    const classEnd = new Date(now);
                    classEnd.setHours(eh, em, 0, 0);

                    if (now < earlyLimit) {
                        // Too early — reject without recording
                        const classStart = new Date(now);
                        classStart.setHours(sh, sm, 0, 0);
                        return {
                            success: false,
                            message: `Too early to scan. Class starts at ${this.formatTime12h(classStart)}. Scanning opens 15 min before class.`,
                        };
                    } else if (now > classEnd) {
                        status = 'absent';   // class already finished
                    } else if (now > graceLimit) {
                        status = 'late';
                    }
                }

                const studentName = `${studentSession.firstname} ${studentSession.lastname}`.trim();

                if (record) {
                    record.timeIn = currentTimeStr;
                    record.status = status;
                    record.name = studentName;
                    if (options.location) record.location = options.location;
                } else {
                    records.push({
                        studentId: studentSession.uid,
                        name: studentName,
                        status,
                        timeIn: currentTimeStr,
                        timeOut: null,
                        remark: '',
                        excuse: null,
                        location: options.location || null,
                    });
                }

                // Update student's own attendance counters
                const sd = this.getStudentData(studentSession.id);
                sd.attendance = sd.attendance || { present: 0, absent: 0, late: 0 };
                if (status === 'late') sd.attendance.late = (sd.attendance.late || 0) + 1;
                else if (status === 'absent') sd.attendance.absent = (sd.attendance.absent || 0) + 1;
                else sd.attendance.present = (sd.attendance.present || 0) + 1;
                sd.scanLog = sd.scanLog || [];
                sd.scanLog.push({ date: qrPayload.date, cls: qrPayload.cls, mode: 'in', time: currentTimeStr, status });
                this.saveStudentData(studentSession.id, sd);

                this.saveTeacherData(teacher.id, td);
                const label = status === 'late' ? 'Late ⚠' :
                    status === 'absent' ? 'Absent ✗ (class already ended)' :
                        'Present ✓';
                return { success: true, message: `Time In at ${currentTimeStr} — ${label}`, status };

            } else {
                // ── mode === 'out' ─────────────────────────────────────────────

                if (!record || !record.timeIn) {
                    return { success: false, message: 'You must time in first before timing out.' };
                }
                if (record.timeOut) {
                    return {
                        success: false,
                        message: `Already timed out at ${record.timeOut} for this class today.`,
                    };
                }

                record.timeOut = currentTimeStr;

                const sd = this.getStudentData(studentSession.id);
                sd.scanLog = sd.scanLog || [];
                sd.scanLog.push({ date: qrPayload.date, cls: qrPayload.cls, mode: 'out', time: currentTimeStr });
                this.saveStudentData(studentSession.id, sd);

                this.saveTeacherData(teacher.id, td);
                return { success: true, message: `Time Out at ${currentTimeStr}`, status: 'out' };
            }
        },

        // ── Session helpers ────────────────────────────────────────────────────

        setSession(user) {
            const { password, ...safe } = user;
            sessionStorage.setItem(SKEY, JSON.stringify(safe));
        },

        getSession() {
            try { return JSON.parse(sessionStorage.getItem(SKEY) || 'null'); }
            catch { return null; }
        },

        clearSession() { sessionStorage.removeItem(SKEY); },

        requireAuth(allowedRoles) {
            const user = this.getSession();
            if (!user || !allowedRoles.includes(user.role)) {
                window.location.replace('index.html');
                return null;
            }
            return user;
        },

        /**
         * Dev utility — wipe all AttendEase data.
         * Call DB.reset() in the browser console, then reload.
         */
        reset() {
            Object.keys(localStorage)
                .filter(k => k.startsWith('attendease'))
                .forEach(k => localStorage.removeItem(k));
            this.clearSession();
            console.log('[AttendEase] Storage cleared. Reload to re-seed.');
        },

        /**
         * Called by the student dashboard when submitting an excuse letter.
         * Writes the excuse file (as base64 dataUrl) into the teacher session
         * record for the given class + date and marks the student as 'excused'.
         *
         * @param {object} studentSession — the logged-in student session
         * @param {string} classCode      — e.g. 'ENG'
         * @param {string} date           — 'YYYY-MM-DD'
         * @param {string} dataUrl        — base64-encoded file content
         * @param {string} fileName       — original file name for reference
         * @returns {{ success:boolean, message:string }}
         */
        submitStudentExcuse(studentSession, classCode, date, dataUrl, fileName) {
            const teacher = this.getTeacherAccount();
            if (!teacher) return { success: false, message: 'No teacher account found.' };

            const td = this.getTeacherData(teacher.id);
            const key = `${classCode}_${date}`;
            if (!td.sessions[key]) td.sessions[key] = [];

            let record = td.sessions[key].find(r => r.studentId === studentSession.uid);
            if (!record) {
                // Create a new record if one doesn't exist yet for this student
                record = {
                    studentId: studentSession.uid,
                    name: `${studentSession.firstname} ${studentSession.lastname}`.trim(),
                    status: 'excused',
                    timeIn: null,
                    timeOut: null,
                    remark: '',
                    excuse: null,
                };
                td.sessions[key].push(record);
            }

            record.excuse = dataUrl;
            record.excuseFileName = fileName || 'excuse_letter';
            record.excuseSubmittedAt = new Date().toISOString();
            record.status = 'excused';

            this.saveTeacherData(teacher.id, td);

            // Also store a reference in the student's own data
            const sd = this.getStudentData(studentSession.id);
            sd.excuseLetters = sd.excuseLetters || [];
            // Remove any previous one for same class+date, then push new
            sd.excuseLetters = sd.excuseLetters.filter(e => !(e.classCode === classCode && e.date === date));
            sd.excuseLetters.push({ classCode, date, fileName: fileName || 'excuse_letter', submittedAt: record.excuseSubmittedAt });
            this.saveStudentData(studentSession.id, sd);

            return { success: true, message: 'Excuse letter submitted successfully ✓' };
        },

        /**
         * Returns the excuse letter dataUrl (or null) that a student submitted
         * for a given class + date, reading from the teacher's session record.
         */
        getStudentExcuse(studentUid, classCode, date) {
            const teacher = this.getTeacherAccount();
            if (!teacher) return null;
            const td = this.getTeacherData(teacher.id);
            const key = `${classCode}_${date}`;
            const records = td.sessions[key] || [];
            const record = records.find(r => r.studentId === studentUid);
            return record ? { dataUrl: record.excuse, fileName: record.excuseFileName, submittedAt: record.excuseSubmittedAt } : null;
        },

        /**
         * DEV ONLY — Clears timeIn and timeOut for every student in every
         * teacher session. Also resets each student's scan log and counters.
         * Triggered automatically on page load when DEV_CLEAR_ATTENDANCE_TIMES = true.
         * You can also call DB.clearAllAttendanceTimes() from the browser console.
         */
        clearAllAttendanceTimes() {
            this.getAll().filter(u => u.role === 'teacher').forEach(teacher => {
                const td = this.getTeacherData(teacher.id);
                Object.values(td.sessions).forEach(records =>
                    records.forEach(r => { r.timeIn = null; r.timeOut = null; })
                );
                this.saveTeacherData(teacher.id, td);
            });
            this.getAll().filter(u => u.role === 'student').forEach(student => {
                const sd = this.getStudentData(student.id);
                sd.scanLog = [];
                sd.attendance = { present: 0, absent: 0, late: 0 };
                this.saveStudentData(student.id, sd);
            });
            console.log('[AttendEase DEV] All attendance times cleared.');
        },
    };
})();

// Auto-seed / migrate on every page load
DB.seed();

// DEV: auto-clear attendance times when the flag above is set to true
if (DEV_CLEAR_ATTENDANCE_TIMES) {
    DB.clearAllAttendanceTimes();
}
