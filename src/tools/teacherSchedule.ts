import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { teacherCache, classCache, SimpleCache } from '../cache/index.js';
import {
  GetClassesRequest,
  Class,
  Staff,
  TeacherSchedule,
} from '../types/mindbody.js';
import {
  getWeekFromDate,
  getDayOfWeek,
  formatTime,
  getDurationInMinutes,
  getDateOnly,
} from '../utils/dates.js';
import { resolveReadTimeZone, siteDateString } from '../utils/siteTime.js';

async function findTeacherByName(
  name: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = teacherCache
): Promise<Staff | null> {
  const cacheKey = `teacher:${name.toLowerCase()}`;
  const cached = cache.get<Staff>(cacheKey);

  if (cached) {
    return cached;
  }

  // Every staff member, across all pages: a teacher beyond the first page must
  // still be found.
  const { items: staffMembers } = await fetchAllPages<Staff>(client, '/staff/staff', {}, 'StaffMembers');

  // Find matching teacher (case-insensitive)
  const teacher = staffMembers.find(
    (staff) => staff.Name.toLowerCase() === name.toLowerCase() ||
              `${staff.FirstName} ${staff.LastName}`.toLowerCase() === name.toLowerCase()
  );

  if (teacher) {
    cache.set(cacheKey, teacher);
  }

  return teacher || null;
}

export async function getTeacherScheduleTool(
  teacherName: string,
  startDate?: string,
  endDate?: string,
  client: IMindbodyClient = mindbodyClient,
  teacherCacheOverride?: SimpleCache,
  classCacheOverride?: SimpleCache
): Promise<TeacherSchedule> {
  const tCache = teacherCacheOverride || teacherCache;
  const cCache = classCacheOverride || classCache;

  // Find the teacher
  const teacher = await findTeacherByName(teacherName, client, tCache);
  
  if (!teacher) {
    throw new Error(`Teacher "${teacherName}" not found. Please check the spelling and try again.`);
  }

  // Set date range. The default week starts on the site's calendar date today,
  // not this process's (UTC or otherwise) date.
  const dateRange = startDate
    ? { start: startDate, end: endDate || getWeekFromDate(startDate).end }
    : getWeekFromDate(siteDateString(new Date(), await resolveReadTimeZone(client, cCache)));

  // Check cache for classes
  const cacheKey = `classes:${teacher.Id}:${dateRange.start}:${dateRange.end}`;
  let classes = cCache.get<Class[]>(cacheKey);

  if (!classes) {
    // Fetch classes from API
    const request: GetClassesRequest = {
      StaffIds: [teacher.Id],
      StartDateTime: `${dateRange.start}T00:00:00`,
      EndDateTime: `${dateRange.end}T23:59:59`,
    };

    ({ items: classes } = await fetchAllPages<Class>(client, '/class/classes', { ...request }, 'Classes'));

    cCache.set(cacheKey, classes);
  }

  // Process and format the results
  const formattedClasses = classes.map((cls) => ({
    id: cls.Id,
    name: cls.ClassDescription?.Name || '',
    startTime: cls.StartDateTime,
    endTime: cls.EndDateTime,
    duration: getDurationInMinutes(cls.StartDateTime, cls.EndDateTime),
    location: cls.Location?.Name || '',
    isSubstitute: cls.IsSubstitute,
    isCanceled: cls.IsCanceled,
    spotsAvailable: cls.MaxCapacity - cls.TotalBooked,
    totalSpots: cls.MaxCapacity,
  }));

  // Generate summaries
  const summary = {
    byDay: {} as Record<string, number>,
    byLocation: {} as Record<string, number>,
    byClassType: {} as Record<string, number>,
  };

  formattedClasses.forEach((cls) => {
    if (!cls.isCanceled) {
      // By day
      const day = getDayOfWeek(cls.startTime);
      summary.byDay[day] = (summary.byDay[day] || 0) + 1;

      // By location
      summary.byLocation[cls.location] = (summary.byLocation[cls.location] || 0) + 1;

      // By class type
      summary.byClassType[cls.name] = (summary.byClassType[cls.name] || 0) + 1;
    }
  });

  // Sort classes by start time. Mindbody's site-local "YYYY-MM-DDTHH:mm:ss"
  // strings sort chronologically as text; parsing them with `new Date()` would
  // read them in this process's zone instead of the site's.
  formattedClasses.sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );

  return {
    teacher: {
      id: teacher.Id,
      name: teacher.Name,
      email: teacher.Email,
    },
    dateRange,
    totalClasses: formattedClasses.filter(c => !c.isCanceled).length,
    classes: formattedClasses,
    summary,
  };
}
