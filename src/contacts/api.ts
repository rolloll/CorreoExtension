import { getAuthToken } from "../gmail/auth";

const PEOPLE_BASE = "https://people.googleapis.com/v1";
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

export interface PersonName {
  givenName?: string;
  familyName?: string;
  displayName?: string;
}
export interface PersonEmail {
  value: string;
  type?: string;
}
export interface PersonPhone {
  value: string;
  type?: string;
}
export interface PersonOrg {
  name?: string;
  title?: string;
}
export interface Person {
  resourceName: string;
  etag: string;
  names?: PersonName[];
  emailAddresses?: PersonEmail[];
  phoneNumbers?: PersonPhone[];
  organizations?: PersonOrg[];
}

export interface ContactFormFields {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  org: string;
}

async function peopleFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken(false);
  return fetch(`${PEOPLE_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}

async function peopleJson<T>(path: string, context: string, init?: RequestInit): Promise<T> {
  const resp = await peopleFetch(path, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${context} 실패 (${resp.status}): ${text}`);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${context} 응답 해석 실패: ${e} / 응답 내용: ${text.slice(0, 300)}`);
  }
}

export async function listContacts(): Promise<Person[]> {
  const people: Person[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: "200",
      sortOrder: "FIRST_NAME_ASCENDING",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await peopleJson<{ connections?: Person[]; nextPageToken?: string }>(
      `/people/me/connections?${params.toString()}`,
      "연락처 목록 조회",
    );
    people.push(...(data.connections || []));
    pageToken = data.nextPageToken;
  } while (pageToken && people.length < 5000);
  return people;
}

// Google Workspace's shared org directory (e.g. every @samyangcnc.com
// address), as opposed to the user's own personal contacts. Only available
// on Workspace accounts, and read-only — these aren't something Correo can
// edit, they're managed by the org / synced from the admin's directory.
export async function listDirectoryPeople(): Promise<Person[]> {
  const people: Person[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ readMask: PERSON_FIELDS, pageSize: "500" });
    params.append("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
    params.append("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT");
    if (pageToken) params.set("pageToken", pageToken);
    const data = await peopleJson<{ people?: Person[]; nextPageToken?: string }>(
      `/people:listDirectoryPeople?${params.toString()}`,
      "조직 주소록 조회",
    );
    people.push(...(data.people || []));
    pageToken = data.nextPageToken;
  } while (pageToken && people.length < 5000);
  return people;
}

function buildPersonBody(fields: ContactFormFields): Record<string, unknown> {
  return {
    names:
      fields.givenName || fields.familyName
        ? [{ givenName: fields.givenName, familyName: fields.familyName }]
        : [],
    emailAddresses: fields.email ? [{ value: fields.email }] : [],
    phoneNumbers: fields.phone ? [{ value: fields.phone }] : [],
    organizations: fields.org ? [{ name: fields.org }] : [],
  };
}

export async function createContact(fields: ContactFormFields): Promise<Person> {
  return peopleJson<Person>("/people:createContact", "연락처 생성", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPersonBody(fields)),
  });
}

export async function updateContact(
  resourceName: string,
  etag: string,
  fields: ContactFormFields,
): Promise<Person> {
  const body = { etag, ...buildPersonBody(fields) };
  return peopleJson<Person>(
    `/${resourceName}:updateContact?updatePersonFields=${PERSON_FIELDS}`,
    "연락처 수정",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function deleteContact(resourceName: string): Promise<void> {
  await peopleJson(`/${resourceName}:deleteContact`, "연락처 삭제", { method: "DELETE" });
}
