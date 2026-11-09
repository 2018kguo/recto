use hayro_syntax::object::dict::keys::{BASE_STATE, D, OCGS, OCMD, OCPROPERTIES, OFF, ON, P, TYPE, VE};
use hayro_syntax::object::{Array, Dict, Name, Object, ObjectIdentifier};
use crate::context::PageBudget;
use std::collections::HashSet;
use std::sync::Arc;

pub(crate) struct OcgState {
    inactive_ocgs: HashSet<ObjectIdentifier>,
    visibility_stack: Vec<bool>,
    /// recto: where a `/VE` that ran out says so.
    budget: Option<Arc<PageBudget>>,
    /// recto: whether each membership dictionary met so far is on. It depends only on the
    /// dictionary, and reading one of n groups for each of m `BDC`s took m×n: 16,000 of each took
    /// 13 s.
    ocmds: rustc_hash::FxHashMap<ObjectIdentifier, bool>,
}

std::thread_local! {
    static OCMD_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// recto: how many membership dictionaries this thread has read, for the tests that each is read once
/// a page.
#[doc(hidden)]
pub fn ocmd_reads() -> usize {
    OCMD_READS.with(|n| n.get())
}

impl OcgState {
    fn dummy() -> Self {
        Self {
            inactive_ocgs: HashSet::default(),
            visibility_stack: vec![],
            budget: None,
            ocmds: Default::default(),
        }
    }

    pub(crate) fn with_budget(mut self, budget: Arc<PageBudget>) -> Self {
        self.budget = Some(budget);
        self
    }

    pub(crate) fn from_catalog(catalog: &Dict<'_>) -> Self {
        let Some(oc_properties) = catalog.get::<Dict<'_>>(OCPROPERTIES) else {
            return Self::dummy();
        };

        let Some(config) = oc_properties.get::<Dict<'_>>(D) else {
            return Self::dummy();
        };

        let mut inactive = HashSet::new();

        let base_state = config
            .get::<Name<'_>>(BASE_STATE)
            .and_then(|b| BaseState::from_name(b.as_ref()));

        if base_state.unwrap_or(BaseState::On) == BaseState::Off
            && let Some(ocgs) = oc_properties.get::<Array<'_>>(OCGS)
        {
            for item in ocgs.raw_iter() {
                if let Some(ref_) = item.as_obj_ref() {
                    let id: ObjectIdentifier = ref_.into();
                    inactive.insert(id);
                }
            }
        }

        let mut read_ocg_array = |key, insert_active: bool| {
            if let Some(arr) = config.get::<Array<'_>>(key) {
                for item in arr.raw_iter() {
                    if let Some(ref_) = item.as_obj_ref() {
                        let id: ObjectIdentifier = ref_.into();
                        if insert_active {
                            inactive.remove(&id);
                        } else {
                            inactive.insert(id);
                        }
                    }
                }
            }
        };

        read_ocg_array(ON, true);
        read_ocg_array(OFF, false);

        Self {
            inactive_ocgs: inactive,
            visibility_stack: Vec::new(),
            budget: None,
            ocmds: Default::default(),
        }
    }

    pub(crate) fn begin_single_oc(&mut self, ocg_id: ObjectIdentifier) {
        let is_active = !self.inactive_ocgs.contains(&ocg_id);
        let visible = self.is_visible() && is_active;
        self.visibility_stack.push(visible);
    }

    /// recto: a visibility expression (`/VE`): `[/And a b ...]`, `[/Or a b ...]` or `[/Not a]`, whose
    /// operands are groups or further expressions.
    /// `nodes` is what's left to visit: an operand can name the same expression twice, so depth alone
    /// leaves 2^32, each time the content uses it.
    fn evaluate_expression(&self, expression: &Array<'_>, depth: usize, nodes: &mut u32) -> Option<bool> {
        const MAX_DEPTH: usize = 32;
        if depth > MAX_DEPTH || *nodes == 0 {
            if let Some(budget) = &self.budget {
                budget.trip();
            }
            return None;
        }
        *nodes -= 1;
        let mut raw = expression.raw_iter();
        let mut resolved = expression.iter::<Object<'_>>();
        raw.next();
        let operator = resolved.next()?.into_name()?;
        let mut operands = Vec::new();
        for (item, object) in raw.zip(resolved) {
            let value = match (item.as_obj_ref(), object) {
                (_, Object::Array(nested)) => self.evaluate_expression(&nested, depth + 1, nodes),
                (Some(reference), _) => {
                    let id: ObjectIdentifier = reference.into();
                    Some(!self.inactive_ocgs.contains(&id))
                }
                _ => None,
            };
            if let Some(value) = value {
                operands.push(value);
            }
        }
        match operator.as_ref() {
            b"And" => Some(operands.iter().all(|&on| on)),
            b"Or" => Some(operands.iter().any(|&on| on)),
            b"Not" => operands.first().map(|&on| !on),
            _ => None,
        }
    }

    pub(crate) fn begin_ocmd(&mut self, ocmd: &Dict<'_>) {
        let id = ocmd.obj_id();
        let on = match id.and_then(|id| self.ocmds.get(&id)) {
            Some(&on) => on,
            None => {
                OCMD_READS.with(|n| n.set(n.get() + 1));
                let on = self.ocmd_on(ocmd);
                if let Some(id) = id {
                    self.ocmds.insert(id, on);
                }
                on
            }
        };
        let visible = self.is_visible() && on;
        self.visibility_stack.push(visible);
    }

    fn ocmd_on(&self, ocmd: &Dict<'_>) -> bool {
        // recto: `/VE` takes the place of `/OCGs` and `/P` for a reader that understands it.
        if let Some(on) = ocmd
            .get::<Array<'_>>(VE)
            .and_then(|expression| {
                let mut nodes = PageBudget::EXPRESSION_NODES;
                let on = self.evaluate_expression(&expression, 0, &mut nodes);
                if let Some(budget) = &self.budget {
                    budget.note_expression(PageBudget::EXPRESSION_NODES - nodes);
                }
                on
            })
        {
            return on;
        }

        let policy = ocmd
            .get::<Name<'_>>(P)
            .and_then(|n| OcmdPolicy::from_name(n.as_ref()))
            .unwrap_or(OcmdPolicy::AnyOn);

        let mut ocg_ids: Vec<ObjectIdentifier> = Vec::new();

        if let Some(arr) = ocmd.get::<Array<'_>>(OCGS) {
            for item in arr.raw_iter() {
                if let Some(ref_) = item.as_obj_ref() {
                    ocg_ids.push(ref_.into());
                }
            }
        } else if let Some(ref_) = ocmd.get_ref(OCGS) {
            ocg_ids.push(ref_.into());
        }

        if ocg_ids.is_empty() {
            true
        } else {
            match policy {
                OcmdPolicy::AllOn => ocg_ids.iter().all(|id| !self.inactive_ocgs.contains(id)),
                OcmdPolicy::AnyOn => ocg_ids.iter().any(|id| !self.inactive_ocgs.contains(id)),
                OcmdPolicy::AnyOff => ocg_ids.iter().any(|id| self.inactive_ocgs.contains(id)),
                OcmdPolicy::AllOff => ocg_ids.iter().all(|id| self.inactive_ocgs.contains(id)),
            }
        }
    }

    pub(crate) fn begin_ocg(&mut self, props: &Dict<'_>, ref_id: ObjectIdentifier) {
        match props.get::<Name<'_>>(TYPE).as_deref() {
            Some(OCMD) => self.begin_ocmd(props),
            _ => self.begin_single_oc(ref_id),
        }
    }

    pub(crate) fn begin_marked_content(&mut self) {
        let visible = self.is_visible();
        self.visibility_stack.push(visible);
    }

    pub(crate) fn end_marked_content(&mut self) {
        self.visibility_stack.pop();
    }

    pub(crate) fn is_visible(&self) -> bool {
        self.visibility_stack.last().copied().unwrap_or(true)
    }
}

impl Default for OcgState {
    fn default() -> Self {
        Self::dummy()
    }
}

#[derive(Debug, PartialEq, Eq, Copy, Clone)]
enum BaseState {
    On,
    Off,
    Unchanged,
}

impl BaseState {
    fn from_name(name: &[u8]) -> Option<Self> {
        match name {
            b"ON" => Some(Self::On),
            b"OFF" => Some(Self::Off),
            b"Unchanged" => Some(Self::Unchanged),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq, Copy, Clone)]
enum OcmdPolicy {
    AllOn,
    AnyOn,
    AnyOff,
    AllOff,
}

impl OcmdPolicy {
    fn from_name(name: &[u8]) -> Option<Self> {
        match name {
            b"AllOn" => Some(Self::AllOn),
            b"AnyOn" => Some(Self::AnyOn),
            b"AnyOff" => Some(Self::AnyOff),
            b"AllOff" => Some(Self::AllOff),
            _ => None,
        }
    }
}
