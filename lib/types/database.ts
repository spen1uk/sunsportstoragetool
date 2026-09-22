// Hand-authored to match supabase/migrations/*.sql. Once the project is
// linked (`supabase link`), regenerate the real thing with:
//   npm run db:types
// and this file will be overwritten with the generated version.

export type AppRole = "admin" | "manager" | "employee";

export type UnitType =
  | "boat"
  | "pontoon"
  | "tritoon"
  | "wake_boat"
  | "fishing_boat"
  | "pwc"
  | "rv"
  | "camper"
  | "trailer"
  | "other";

export type StorageType =
  | "heated_indoor"
  | "cold_indoor"
  | "outdoor"
  | "shrink_wrapped"
  | "temporary"
  | "other";

export type LocationType =
  | "storage_spot"
  | "intake_area"
  | "service_bay"
  | "detail_bay"
  | "outdoor_staging"
  | "spring_pickup_area"
  | "delivery_area"
  | "temporary_location";

export type LocationAdminStatus = "available" | "reserved" | "unavailable";
export type ServiceStatus = "requested" | "scheduled" | "in_progress" | "complete";
export type PickupStatus = "scheduled" | "ready" | "completed";
export type FuelLevel = "empty" | "quarter" | "half" | "three_quarter" | "full";
export type NotableEntity = "unit" | "customer" | "intake";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string;
          role: AppRole;
          phone: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["profiles"]["Row"]> & { id: string; full_name: string };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Row"]>;
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          first_name: string;
          last_name: string;
          phone: string | null;
          email: string | null;
          address: string | null;
          city: string | null;
          state: string | null;
          zip: string | null;
          secondary_contact_name: string | null;
          secondary_contact_phone: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["customers"]["Row"]> & {
          first_name: string;
          last_name: string;
        };
        Update: Partial<Database["public"]["Tables"]["customers"]["Row"]>;
        Relationships: [];
      };
      facilities: {
        Row: {
          id: string;
          name: string;
          address: string | null;
          city: string | null;
          state: string | null;
          zip: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["facilities"]["Row"]> & { name: string };
        Update: Partial<Database["public"]["Tables"]["facilities"]["Row"]>;
        Relationships: [];
      };
      buildings: {
        Row: {
          id: string;
          facility_id: string;
          name: string;
          code: string;
          description: string | null;
          sort_order: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["buildings"]["Row"]> & {
          facility_id: string;
          name: string;
          code: string;
        };
        Update: Partial<Database["public"]["Tables"]["buildings"]["Row"]>;
        Relationships: [];
      };
      storage_locations: {
        Row: {
          id: string;
          facility_id: string;
          building_id: string | null;
          full_code: string;
          section: string | null;
          spot_number: string | null;
          location_type: LocationType;
          storage_type: StorageType;
          max_length_ft: number | null;
          max_width_ft: number | null;
          admin_status: LocationAdminStatus;
          position_x: number | null;
          position_y: number | null;
          rotation: number | null;
          sort_order: number;
          is_active: boolean;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["storage_locations"]["Row"]> & {
          facility_id: string;
          full_code: string;
        };
        Update: Partial<Database["public"]["Tables"]["storage_locations"]["Row"]>;
        Relationships: [];
      };
      unit_statuses: {
        Row: {
          code: string;
          label: string;
          color: string;
          icon: string;
          sort_order: number;
          is_terminal: boolean;
        };
        Insert: Database["public"]["Tables"]["unit_statuses"]["Row"];
        Update: Partial<Database["public"]["Tables"]["unit_statuses"]["Row"]>;
        Relationships: [];
      };
      units: {
        Row: {
          id: string;
          internal_storage_id: string;
          qr_token: string;
          customer_id: string;
          unit_type: UnitType;
          year: number | null;
          make: string | null;
          model: string | null;
          length_ft: number | null;
          beam_ft: number | null;
          registration_number: string | null;
          hin: string | null;
          engine_make: string | null;
          engine_model: string | null;
          horsepower: number | null;
          engine_hours: number | null;
          trailer_included: boolean;
          trailer_make: string | null;
          trailer_plate: string | null;
          storage_type: StorageType;
          status_code: string;
          arrival_date: string | null;
          expected_pickup_date: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["units"]["Row"]> & { customer_id: string };
        Update: Partial<Database["public"]["Tables"]["units"]["Row"]>;
        Relationships: [];
      };
      location_assignments: {
        Row: {
          id: string;
          unit_id: string;
          storage_location_id: string;
          assigned_at: string;
          unassigned_at: string | null;
          assigned_by: string | null;
          notes: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["location_assignments"]["Row"]> & {
          unit_id: string;
          storage_location_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["location_assignments"]["Row"]>;
        Relationships: [];
      };
      location_history: {
        Row: {
          id: string;
          unit_id: string;
          from_location_id: string | null;
          to_location_id: string | null;
          moved_by: string | null;
          moved_at: string;
          note: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["location_history"]["Row"]> & { unit_id: string };
        Update: Partial<Database["public"]["Tables"]["location_history"]["Row"]>;
        Relationships: [];
      };
      service_types: {
        Row: { id: string; name: string; category: string | null; is_active: boolean };
        Insert: Partial<Database["public"]["Tables"]["service_types"]["Row"]> & { name: string };
        Update: Partial<Database["public"]["Tables"]["service_types"]["Row"]>;
        Relationships: [];
      };
      unit_services: {
        Row: {
          id: string;
          unit_id: string;
          service_type_id: string;
          status: ServiceStatus;
          requested_at: string;
          scheduled_at: string | null;
          completed_at: string | null;
          assigned_employee_id: string | null;
          notes: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["unit_services"]["Row"]> & {
          unit_id: string;
          service_type_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["unit_services"]["Row"]>;
        Relationships: [];
      };
      intakes: {
        Row: {
          id: string;
          unit_id: string;
          performed_by: string | null;
          fuel_level: FuelLevel | null;
          engine_hours: number | null;
          key_received: boolean;
          cover_received: boolean;
          trailer_included: boolean;
          existing_damage: string | null;
          special_instructions: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["intakes"]["Row"]> & { unit_id: string };
        Update: Partial<Database["public"]["Tables"]["intakes"]["Row"]>;
        Relationships: [];
      };
      pickups: {
        Row: {
          id: string;
          unit_id: string;
          requested_pickup_date: string | null;
          actual_pickup_date: string | null;
          status: PickupStatus;
          scheduled_by: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["pickups"]["Row"]> & { unit_id: string };
        Update: Partial<Database["public"]["Tables"]["pickups"]["Row"]>;
        Relationships: [];
      };
      notes: {
        Row: {
          id: string;
          entity_type: NotableEntity;
          entity_id: string;
          author_id: string | null;
          body: string;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["notes"]["Row"]> & {
          entity_type: NotableEntity;
          entity_id: string;
          body: string;
        };
        Update: Partial<Database["public"]["Tables"]["notes"]["Row"]>;
        Relationships: [];
      };
      photos: {
        Row: {
          id: string;
          entity_type: NotableEntity;
          entity_id: string;
          storage_path: string;
          caption: string | null;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["photos"]["Row"]> & {
          entity_type: NotableEntity;
          entity_id: string;
          storage_path: string;
        };
        Update: Partial<Database["public"]["Tables"]["photos"]["Row"]>;
        Relationships: [];
      };
      activity_logs: {
        Row: {
          id: string;
          employee_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          old_value: Record<string, unknown> | null;
          new_value: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["activity_logs"]["Row"]> & {
          action: string;
          entity_type: string;
        };
        Update: Partial<Database["public"]["Tables"]["activity_logs"]["Row"]>;
        Relationships: [];
      };
    };
    Views: {
      v_location_occupancy: {
        Row: {
          location_id: string;
          facility_id: string;
          building_id: string | null;
          storage_type: StorageType;
          location_type: LocationType;
          admin_status: LocationAdminStatus;
          is_active: boolean;
          occupied_by_unit_id: string | null;
        };
        Relationships: [];
      };
      v_capacity_by_storage_type: {
        Row: { storage_type: StorageType; total_spaces: number; occupied_spaces: number };
        Relationships: [];
      };
      v_capacity_by_building: {
        Row: { building_id: string; total_spaces: number; occupied_spaces: number };
        Relationships: [];
      };
    };
    Functions: {
      current_role: { Args: Record<string, never>; Returns: AppRole };
      move_unit: {
        Args: { p_unit_id: string; p_new_location_id: string; p_note?: string | null };
        Returns: void;
      };
      remove_unit_from_storage: {
        Args: { p_unit_id: string; p_note?: string | null };
        Returns: void;
      };
      search_everything: {
        Args: { p_query: string };
        Returns: {
          result_type: "unit" | "customer";
          id: string;
          title: string;
          subtitle: string;
          href: string;
        }[];
      };
    };
  };
}
