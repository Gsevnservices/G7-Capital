// ═══════════════════════════════════════════════════════════════
// G7 SCOUT — PIPELINE DATA LAYER
// File: assets/pipeline.js
//
// Manages the named-contact pipeline stored in localStorage.
// Load this file BEFORE any Scout page that needs pipeline data.
//
// Storage key: 'scout_pipeline'
// Shape: { people: [...], anonymousContacts: [...] }
//
// People statuses: contacted | replied | trial_booked | joined |
//                  gone_quiet | not_interested
// ═══════════════════════════════════════════════════════════════

'use strict';

/* ---------- Pipeline store (Scout) ---------- */

var PIPELINE_KEY = 'scout_pipeline';

/* Read the whole pipeline. Never throws — returns an empty store on any failure. */
function pipelineLoad() {
  try {
    var raw = localStorage.getItem(PIPELINE_KEY);
    if (!raw) return { people: [], anonymousContacts: [] };
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return { people: [], anonymousContacts: [] };
    if (!Array.isArray(p.people)) p.people = [];
    if (!Array.isArray(p.anonymousContacts)) p.anonymousContacts = [];
    return p;
  } catch (e) {
    console.error('pipelineLoad failed:', e);
    return { people: [], anonymousContacts: [] };
  }
}

/* Write the whole pipeline. Returns true on success. */
function pipelineSave(store) {
  try {
    if (!store || !Array.isArray(store.people)) return false;
    localStorage.setItem(PIPELINE_KEY, JSON.stringify(store));
    return true;
  } catch (e) {
    console.error('pipelineSave failed:', e);
    return false;
  }
}

/* Add a named person. Returns the new person object, or the existing one
   if a person with the same name already exists (case-insensitive). */
function pipelineAddPerson(name, opts) {
  opts = opts || {};
  var store = pipelineLoad();
  var clean = String(name || '').trim();
  if (!clean) return null;

  var existing = null;
  for (var i = 0; i < store.people.length; i++) {
    if (store.people[i].name && store.people[i].name.toLowerCase() === clean.toLowerCase()) {
      existing = store.people[i];
      break;
    }
  }
  var now = new Date().toISOString();
  if (existing) {
    existing.lastContactedAt = now;
    if (opts.messageId && existing.messagesSent.indexOf(opts.messageId) === -1) {
      existing.messagesSent.push(opts.messageId);
    }
    existing.history.push({ week: opts.week || 0, event: 'contacted', at: now });
    pipelineSave(store);
    return existing;
  }

  var person = {
    id: 'p_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name: clean,
    phone: String(opts.phone || '').replace(/[^0-9]/g, ''),
    icp: opts.icp || '',
    status: 'contacted',
    addedWeek: opts.week || 0,
    lastContactedAt: now,
    lastStatusAt: now,
    messagesSent: opts.messageId ? [opts.messageId] : [],
    note: opts.note || '',
    history: [{ week: opts.week || 0, event: 'contacted', at: now }]
  };
  store.people.push(person);
  pipelineSave(store);
  return person;
}

/* Record a contact where the user skipped naming the person. */
function pipelineAddAnonymous(icp, week) {
  var store = pipelineLoad();
  var found = null;
  for (var i = 0; i < store.anonymousContacts.length; i++) {
    if (store.anonymousContacts[i].week === week && store.anonymousContacts[i].icp === icp) {
      found = store.anonymousContacts[i];
      break;
    }
  }
  if (found) { found.count += 1; }
  else { store.anonymousContacts.push({ week: week || 0, icp: icp || '', count: 1 }); }
  pipelineSave(store);
  return true;
}

/* Update a person's status. Valid: contacted, replied, trial_booked, joined, gone_quiet, not_interested */
function pipelineSetStatus(personId, status, week, note) {
  var VALID = ['contacted','replied','trial_booked','joined','gone_quiet','not_interested'];
  if (VALID.indexOf(status) === -1) return false;
  var store = pipelineLoad();
  for (var i = 0; i < store.people.length; i++) {
    if (store.people[i].id === personId) {
      var now = new Date().toISOString();
      store.people[i].status = status;
      store.people[i].lastStatusAt = now;
      if (note) store.people[i].note = note;
      store.people[i].history.push({ week: week || 0, event: status, at: now });
      return pipelineSave(store);
    }
  }
  return false;
}

/* Aggregate counts per ICP for a given week — used to replace manual number entry. */
function pipelineWeekStats(week) {
  var store = pipelineLoad();
  var stats = {};
  function bucket(icp) {
    if (!stats[icp]) stats[icp] = { contacted: 0, replied: 0, trial_booked: 0, joined: 0 };
    return stats[icp];
  }
  store.people.forEach(function(p) {
    p.history.forEach(function(h) {
      if (h.week !== week) return;
      var b = bucket(p.icp || 'Unknown');
      if (h.event === 'contacted')    b.contacted++;
      if (h.event === 'replied')      b.replied++;
      if (h.event === 'trial_booked') b.trial_booked++;
      if (h.event === 'joined')       b.joined++;
    });
  });
  store.anonymousContacts.forEach(function(a) {
    if (a.week === week) bucket(a.icp || 'Unknown').contacted += a.count;
  });
  return stats;
}

/* ---------- Chase rules ---------- */

/* Days between two ISO timestamps */
function pipelineDaysSince(iso) {
  if (!iso) return 999;
  var then = new Date(iso).getTime();
  if (isNaN(then)) return 999;
  return Math.floor((Date.now() - then) / 86400000);
}

/* Returns people who need action today, each with a reason and a suggested message.
   Rules:
     contacted, no reply 3+ days   -> follow up
     contacted, no reply 7+ days   -> final follow up
     replied, no trial 5+ days     -> stall breaker
     trial_booked, 1+ days past    -> did they show
     any status, 14+ days silent   -> gone quiet, win-back
   joined and not_interested are never chased. */
function pipelineDue() {
  var store = pipelineLoad();
  var out = [];
  store.people.forEach(function(p) {
    if (p.status === 'joined' || p.status === 'not_interested') return;
    var d = pipelineDaysSince(p.lastStatusAt || p.lastContactedAt);
    var first = (p.name || '').split(' ')[0] || 'there';
    var item = null;

    if (p.status === 'contacted' && d >= 14) {
      item = { reason: 'No response in ' + d + ' days', urgency: 3,
               msg: 'Hi ' + first + ' — last try from my side. Agar kabhi fitness start karna ho toh bas message kar dena. Door nahi hain, Juhu Circle ke paas hi.' };
    } else if (p.status === 'contacted' && d >= 7) {
      item = { reason: 'No reply for ' + d + ' days — final follow-up', urgency: 2,
               msg: 'Hi ' + first + ' — ek baar aur pooch raha hoon. Ek free session try karna ho toh bata dena, slot main hold kar leta hoon.' };
    } else if (p.status === 'contacted' && d >= 3) {
      item = { reason: 'No reply for ' + d + ' days', urgency: 1,
               msg: 'Hi ' + first + ' — pichle message ka follow-up. Free session ke liye koi din suit karta hai?' };
    } else if (p.status === 'replied' && d >= 5) {
      item = { reason: 'Replied ' + d + ' days ago but has not booked', urgency: 3,
               msg: 'Hi ' + first + ' — aapne interest dikhaya tha. Is week ek slot rakh doon? Bas din bata dijiye.' };
    } else if (p.status === 'trial_booked' && d >= 1) {
      item = { reason: 'Trial was ' + d + ' day(s) ago — did they show?', urgency: 3,
               msg: 'Hi ' + first + ' — session kaisa raha? Agar miss ho gaya toh koi baat nahi, dobara rakh dete hain.' };
    } else if (p.status === 'gone_quiet' && d >= 14) {
      item = { reason: 'Quiet for ' + d + ' days', urgency: 1,
               msg: 'Hi ' + first + ' — kaafi time ho gaya. Ek free session pe aa jao, koi commitment nahi.' };
    }

    if (item) {
      item.person = p;
      out.push(item);
    }
  });
  out.sort(function(a, b) { return b.urgency - a.urgency; });
  return out;
}

/* Everyone, sorted: active statuses first, then joined/not_interested */
function pipelineAll() {
  var order = { replied: 0, trial_booked: 1, contacted: 2, gone_quiet: 3, joined: 4, not_interested: 5 };
  var store = pipelineLoad();
  return store.people.slice().sort(function(a, b) {
    return (order[a.status] || 9) - (order[b.status] || 9);
  });
}
